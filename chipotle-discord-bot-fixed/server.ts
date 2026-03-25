import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  Client, 
  GatewayIntentBits, 
  Events, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ActionRowBuilder, 
  StringSelectMenuBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder,
  InteractionType,
  ComponentType,
  ModalActionRowComponentBuilder,
  AttachmentBuilder
} from 'discord.js';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { db, serverTimestamp, getBotConfig, updateBotConfig } from './firebase.ts';
import { collection, addDoc, doc, getDoc, setDoc, updateDoc, query, where, getDocs, orderBy, limit, runTransaction } from 'firebase/firestore';

dotenv.config();

// --- Input Sanitization ---
// Strips Discord markdown/mention exploits and enforces length limits.
function sanitizeInput(input: string, maxLength: number = 200): string {
  return input
    .replace(/@(everyone|here)/gi, '@\u200B$1')   // Neutralize @everyone / @here
    .replace(/<@[!&]?\d+>/g, '[mention]')          // Strip user/role mentions
    .replace(/\n/g, ' ')                           // Collapse newlines
    .slice(0, maxLength)
    .trim();
}

// Validates that a webhook URL is a legitimate Discord webhook
function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
      parsed.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

function createEmbed(config: any) {
  const embed = new EmbedBuilder();
  if (config?.embedColor) {
    try {
      embed.setColor(config.embedColor);
    } catch (e) {
      embed.setColor(0xFF6321);
    }
  } else {
    embed.setColor(0xFF6321);
  }
  
  if (config?.botDisplayName) {
    embed.setAuthor({ name: config.botDisplayName });
  }
  
  if (config?.footerText) {
    embed.setFooter({ text: config.footerText });
  }
  
  return embed;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Discord Client and State
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const orderState = new Map<string, any>();

// Cleanup stale orders every hour to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of orderState.entries()) {
    if (state.lastUpdated && now - state.lastUpdated > 3600000) { // 1 hour
      orderState.delete(userId);
    }
  }
}, 3600000);

function safeParseOrders(data: any): any[] {
  try {
    const parsed = JSON.parse(data || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function safeParseUserInfo(data: any): any {
  try {
    const parsed = JSON.parse(data || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    return {};
  }
}

function generateShortOrderId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  let id = '';
  for (let i = 0; i < 3; i++) id += letters.charAt(Math.floor(Math.random() * letters.length));
  for (let i = 0; i < 3; i++) id += numbers.charAt(Math.floor(Math.random() * numbers.length));
  return id;
}

function formatConfirmedOrderPayload(userId: string, userInfo: any, parsedOrders: any[]) {
  const header = `User: <@${userId}>
Pickup Location(s)? ${userInfo.location || 'N/A'}
Pickup Time? ${userInfo.time || 'N/A'}
Phone #? ${userInfo.phone || 'N/A'}
Email? ${userInfo.email || 'N/A'}`;

  const ordersStr = parsedOrders.map((order: any, index: number) => {
    const proteinStr = order.isDouble 
      ? `Double ${order.proteins[0]}` 
      : order.proteins[0] || 'Veggie';
    
    const toppingLines = [
      ...order.toppings.map((t: any) => t.portion === 'Regular' ? `${t.type}` : `${t.portion} ${t.type}`),
      order.premium !== 'None' ? `${order.premium}` : null
    ].filter(Boolean).join('\n');

    const riceStr = order.rice.portion && order.rice.portion !== 'Regular' 
      ? `${order.rice.portion} ${order.rice.type}` 
      : `${order.rice.type}`;
      
    const beansStr = order.beans.portion && order.beans.portion !== 'Regular' 
      ? `${order.beans.portion} ${order.beans.type}` 
      : `${order.beans.type}`;

    return `Order ${index + 1}\n${userInfo.name || 'N/A'}\n${order.type}\n${proteinStr}\n${riceStr}\n${beansStr}\n${toppingLines}`;
  }).join('\n\n');

  return `${header}\n\n${ordersStr}`;
}

function formatOrderItems(parsedOrders: any[]) {
  return parsedOrders.map((order: any, index: number) => {
    const proteinStr = order.isDouble 
      ? `Double ${order.proteins[0]}` 
      : order.proteins[0] || 'Veggie';
    
    const toppingLines = [
      ...order.toppings.map((t: any) => t.portion === 'Regular' ? `${t.type}` : `${t.portion} ${t.type}`),
      order.premium !== 'None' ? `${order.premium}` : null
    ].filter(Boolean).join('\n');

    const riceStr = order.rice.portion && order.rice.portion !== 'Regular' 
      ? `${order.rice.portion} ${order.rice.type}` 
      : `${order.rice.type}`;
      
    const beansStr = order.beans.portion && order.beans.portion !== 'Regular' 
      ? `${order.beans.portion} ${order.beans.type}` 
      : `${order.beans.type}`;

    return `Order ${index + 1}\n${order.type}\n${proteinStr}\n${riceStr}\n${beansStr}\n${toppingLines}`;
  }).join('\n\n');
}

// Define Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('order')
    .setDescription('Start a new Chipotle order'),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure bot messages (Admin only)'),
  new SlashCommandBuilder()
    .setName('cashapp')
    .setDescription('Configure Cash App tag (Admin only)')
    .addStringOption(option => 
      option.setName('cashtag')
        .setDescription('Your $cashtag (e.g., $JohnDoe)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('admin_orders')
    .setDescription('View and manage orders (Admin only)'),
  new SlashCommandBuilder()
    .setName('admin_batch')
    .setDescription('View and clear the current order batch (Admin only)'),
  new SlashCommandBuilder()
    .setName('reorder')
    .setDescription('Repeat your last order with one click'),
  new SlashCommandBuilder()
    .setName('myorders')
    .setDescription('See your queued orders and status'),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Check your credit balance'),
  new SlashCommandBuilder()
    .setName('support')
    .setDescription('Open a support ticket in the server'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Shows how the bot works'),
  new SlashCommandBuilder()
    .setName('revenue')
    .setDescription('Detailed revenue report (daily/weekly/monthly) (Admin only)'),
  new SlashCommandBuilder()
    .setName('orders')
    .setDescription('View all queued orders from your customers (Admin only)'),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Past order history with results (Admin only)'),
  new SlashCommandBuilder()
    .setName('setprice')
    .setDescription('Change what your customers pay per entree (Admin only)')
    .addNumberOption(option => option.setName('standard').setDescription('Standard price per entree').setRequired(true))
    .addNumberOption(option => option.setName('bulk_price').setDescription('Discounted rate at a quantity you set').setRequired(false))
    .addIntegerOption(option => option.setName('bulk_threshold').setDescription('How many entrees to trigger bulk pricing').setRequired(false)),
  new SlashCommandBuilder()
    .setName('setpayment')
    .setDescription('Update your payment methods (Venmo, Zelle, etc.) (Admin only)'),
  new SlashCommandBuilder()
    .setName('branding')
    .setDescription('Change embed color, bot name, footer text (Admin only)'),
  new SlashCommandBuilder()
    .setName('toggle')
    .setDescription('Enable or disable ordering in your server (Admin only)'),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Quick panel to reconfigure everything at once (Admin only)'),
  new SlashCommandBuilder()
    .setName('forceconfirm')
    .setDescription('Manually confirm a payment if auto-detect missed it (Admin only)')
    .addStringOption(option => option.setName('order_id').setDescription('Order ID to confirm').setRequired(true)),
  new SlashCommandBuilder()
    .setName('removeorder')
    .setDescription('Remove a customer\'s order from the queue (Admin only)')
    .addStringOption(option => option.setName('order_id').setDescription('Order ID to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Block or unblock a customer (Admin only)')
    .addUserOption(option => option.setName('user').setDescription('User to block/unblock').setRequired(true)),
  new SlashCommandBuilder()
    .setName('customers')
    .setDescription('See your top customers by order count (Admin only)'),
  new SlashCommandBuilder()
    .setName('setnickname')
    .setDescription('Change the bot\'s display name in your server (Admin only)')
    .addStringOption(option => option.setName('nickname').setDescription('New nickname').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set a staff role to manage tickets and view orders (Admin only)')
    .addRoleOption(option => option.setName('role').setDescription('Staff role').setRequired(true)),
  new SlashCommandBuilder()
    .setName('announcements')
    .setDescription('Create a new announcement in a channel or via webhook (Admin only)')
    .addStringOption(option => option.setName('message').setDescription('The announcement message').setRequired(true))
    .addChannelOption(option => option.setName('channel').setDescription('The channel to send the announcement to').setRequired(false))
    .addStringOption(option => option.setName('webhook_url').setDescription('Alternatively, a webhook URL to send the announcement to').setRequired(false))
    .addStringOption(option => option.setName('title').setDescription('The title of the announcement').setRequired(false))
    .addStringOption(option => option.setName('image_url').setDescription('An optional image URL to include in the announcement').setRequired(false)),
  new SlashCommandBuilder()
    .setName('fulfillall')
    .setDescription('Mark all paid orders as fulfilled (Admin only)'),
  new SlashCommandBuilder()
    .setName('storestatus')
    .setDescription('Open or close the store for new orders (Admin only)'),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export all orders to a CSV file (Admin only)'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check the status of your recent orders'),
  new SlashCommandBuilder()
    .setName('menu')
    .setDescription('View the current menu and options'),
].map(command => command.toJSON());

// Handle global errors to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      console.warn('⚠️ STRIPE_SECRET_KEY is missing. Stripe functionality will be disabled.');
      return null;
    }
    console.log('✅ STRIPE_SECRET_KEY loaded, initializing Stripe client.');
    stripeClient = new Stripe(key, { apiVersion: '2026-02-25.clover' });
  }
  return stripeClient;
}


async function initDiscordBot() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.error('❌ CRITICAL ERROR: DISCORD_TOKEN or DISCORD_CLIENT_ID is missing.');
    console.error('Please set these in the Secrets/Environment Variables menu to start the bot.');
    return;
  }
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Successfully reloaded application (/) commands.');

    client.once(Events.ClientReady, async c => {
      console.log(`✅ Ready! Logged in as ${c.user.tag}`);
      const config = await getBotConfig() || {};
      if (config.statusMessage) {
        c.user.setActivity(config.statusMessage);
      }
    });

    // Register Interaction Handler
    client.on(Events.InteractionCreate, async interaction => {
      try {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'order') {
            const config = await getBotConfig() || {};
            if (config.storeOpen === false) {
              return await interaction.reply({ content: '❌ **The store is currently closed.** We are not accepting new orders at this time.', ephemeral: true });
            }

            // Check if user is blacklisted
            try {
              const blacklistDoc = await getDoc(doc(db, 'blacklist', interaction.user.id));
              if (blacklistDoc.exists()) {
                return await interaction.reply({ content: '❌ You have been blocked from placing orders. Please contact an admin if you believe this is an error.', ephemeral: true });
              }
            } catch (e) {
              console.error('Error checking blacklist:', e);
            }

            const modal = new ModalBuilder()
              .setCustomId('order_info_modal')
              .setTitle('Chipotle Order - Contact Info');

            const nameInput = new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Name on Order')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);

            const locationInput = new TextInputBuilder()
              .setCustomId('location')
              .setLabel('Pickup Location')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);

            const timeInput = new TextInputBuilder()
              .setCustomId('time')
              .setLabel('Pickup Time (CST)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);

            const phoneInput = new TextInputBuilder()
              .setCustomId('phone')
              .setLabel('Phone Number')
              .setStyle(TextInputStyle.Short)
              .setRequired(true);

            const emailInput = new TextInputBuilder()
              .setCustomId('email')
              .setLabel('Email (Gmail Only)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('user@gmail.com')
              .setRequired(true);

            modal.addComponents(
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(nameInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(locationInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(timeInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(phoneInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(emailInput)
            );

            await interaction.showModal(modal);
          }

          if (interaction.commandName === 'config') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            }

            const config = await getBotConfig() || {};

            const modal = new ModalBuilder()
              .setCustomId('config_modal')
              .setTitle('Bot Message Configuration');
            
            const welcomeInput = new TextInputBuilder()
              .setCustomId('welcomeMessage')
              .setLabel('Welcome Message')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(config.welcomeMessage || 'Great! Now choose your entree:')
              .setRequired(false);

            const entreeInput = new TextInputBuilder()
              .setCustomId('entreePrompt')
              .setLabel('Entree Selection Prompt')
              .setStyle(TextInputStyle.Short)
              .setValue(config.entreePrompt || 'Choose your entree:')
              .setRequired(false);

            const proteinInput = new TextInputBuilder()
              .setCustomId('proteinPrompt')
              .setLabel('Protein Selection Prompt')
              .setStyle(TextInputStyle.Short)
              .setValue(config.proteinPrompt || 'Now choose your protein:')
              .setRequired(false);

            const checkoutInput = new TextInputBuilder()
              .setCustomId('checkoutMessage')
              .setLabel('Checkout Instructions')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(config.checkoutMessage || 'Please pay using the link below. Your order will be sent to the kitchen automatically once payment is confirmed.')
              .setRequired(false);

            const successInput = new TextInputBuilder()
              .setCustomId('successMessage')
              .setLabel('Success Confirmation')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(config.successMessage || '✅ Payment confirmed! Your order has been sent to the kitchen.')
              .setRequired(false);

            modal.addComponents(
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(welcomeInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(entreeInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(proteinInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(checkoutInput),
              new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(successInput)
            );

            await interaction.showModal(modal);
          }

          if (interaction.commandName === 'admin_orders') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            }
            await showAdminOrders(interaction, 'pending');
          }

          if (interaction.commandName === 'admin_batch') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            }
            await showAdminBatch(interaction);
          }

          if (interaction.commandName === 'reorder') {
            await handleReorder(interaction);
          }

          if (interaction.commandName === 'myorders' || interaction.commandName === 'status') {
            await handleMyOrders(interaction);
          }

          if (interaction.commandName === 'menu') {
            await handleMenu(interaction);
          }

          if (interaction.commandName === 'wallet') {
            await handleWallet(interaction);
          }

          if (interaction.commandName === 'support') {
            await handleSupport(interaction);
          }

          if (interaction.commandName === 'help') {
            await handleHelp(interaction);
          }

          if (interaction.commandName === 'cashapp') {
            if (!interaction.memberPermissions?.has('Administrator')) {
              return await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            }
            const cashtag = interaction.options.getString('cashtag');
            const config = await getBotConfig() || {};
            const newConfig = { ...config, cashappTag: cashtag };
            const success = await updateBotConfig(newConfig);
            if (success) {
              await interaction.reply({ content: `✅ Cash App tag updated to **${cashtag}**!`, ephemeral: true });
            } else {
              await interaction.reply({ content: '❌ Failed to update Cash App tag. Check server logs.', ephemeral: true });
            }
          }

          const adminCommands = ['revenue', 'setprice', 'setpayment', 'branding', 'toggle', 'settings', 'blacklist', 'customers', 'setnickname', 'setup', 'announcements', 'fulfillall', 'storestatus', 'export'];
          const staffCommands = ['orders', 'history', 'forceconfirm', 'removeorder'];

          if (adminCommands.includes(interaction.commandName) || staffCommands.includes(interaction.commandName)) {
            const config = await getBotConfig() || {};
            const isStaff = config.staffRoleId && interaction.member?.roles && (interaction.member.roles as any).cache.has(config.staffRoleId);
            const isAdmin = interaction.memberPermissions?.has('Administrator');

            if (adminCommands.includes(interaction.commandName) && !isAdmin) {
              return await interaction.reply({ content: '❌ You must be an Administrator to use this command.', ephemeral: true });
            }

            if (staffCommands.includes(interaction.commandName) && !isAdmin && !isStaff) {
              return await interaction.reply({ content: '❌ You must be Staff or an Administrator to use this command.', ephemeral: true });
            }
            
            if (interaction.commandName === 'orders') {
              await showAdminOrders(interaction, 'pending');
            } else if (interaction.commandName === 'history') {
              await showAdminOrders(interaction, 'paid_fulfilled');
            } else if (interaction.commandName === 'forceconfirm') {
              const orderId = interaction.options.getString('order_id');
              if (orderId) {
                await fulfillOrder(orderId);
                await interaction.reply({ content: `✅ Order ${orderId} manually confirmed.`, ephemeral: true });
              }
            } else if (interaction.commandName === 'removeorder') {
              const orderId = interaction.options.getString('order_id');
              if (orderId) {
                await updateDoc(doc(db, 'orders', orderId), { status: 'cancelled' });
                await interaction.reply({ content: `✅ Order ${orderId} cancelled.`, ephemeral: true });
              }
            } else if (interaction.commandName === 'setnickname') {
              const nickname = interaction.options.getString('nickname');
              try {
                if (interaction.guild?.members.me) {
                  await interaction.guild.members.me.setNickname(nickname);
                  await interaction.reply({ content: `✅ Bot nickname changed to **${nickname}**.`, ephemeral: true });
                } else {
                  await interaction.reply({ content: '❌ Could not change nickname.', ephemeral: true });
                }
              } catch (e) {
                await interaction.reply({ content: '❌ Missing permissions to change nickname.', ephemeral: true });
              }
            } else if (interaction.commandName === 'setup') {
              const role = interaction.options.getRole('role');
              const config = await getBotConfig() || {};
              const newConfig = { ...config, staffRoleId: role.id };
              const success = await updateBotConfig(newConfig);
              if (success) {
                await interaction.reply({ content: `✅ Staff role set to **${role.name}**. Users with this role can now manage tickets and view orders.`, ephemeral: true });
              } else {
                await interaction.reply({ content: '❌ Failed to set staff role.', ephemeral: true });
              }
            } else if (interaction.commandName === 'revenue') {
              await handleRevenue(interaction);
            } else if (interaction.commandName === 'setprice') {
              await handleSetPrice(interaction);
            } else if (interaction.commandName === 'setpayment') {
              await handleSetPayment(interaction);
            } else if (interaction.commandName === 'branding') {
              await handleBranding(interaction);
            } else if (interaction.commandName === 'toggle') {
              await handleToggle(interaction);
            } else if (interaction.commandName === 'settings') {
              await handleSettings(interaction);
            } else if (interaction.commandName === 'blacklist') {
              await handleBlacklist(interaction);
            } else if (interaction.commandName === 'customers') {
              await handleCustomers(interaction);
            } else if (interaction.commandName === 'announcements') {
              await handleAnnouncements(interaction);
            } else if (interaction.commandName === 'fulfillall') {
              await handleFulfillAll(interaction);
            } else if (interaction.commandName === 'storestatus') {
              await handleStoreStatus(interaction);
            } else if (interaction.commandName === 'export') {
              await handleExport(interaction);
            } else {
              await interaction.reply({ content: `🛠️ Command \`/${interaction.commandName}\` is under construction.`, ephemeral: true });
            }
          }


        }

        if (interaction.type === InteractionType.ModalSubmit) {
          if (interaction.customId === 'config_modal') {
            const newConfig = {
              welcomeMessage: interaction.fields.getTextInputValue('welcomeMessage'),
              entreePrompt: interaction.fields.getTextInputValue('entreePrompt'),
              proteinPrompt: interaction.fields.getTextInputValue('proteinPrompt'),
              checkoutMessage: interaction.fields.getTextInputValue('checkoutMessage'),
              successMessage: interaction.fields.getTextInputValue('successMessage'),
            };

            const success = await updateBotConfig(newConfig);
            if (success) {
              await interaction.reply({ content: '✅ Bot configuration updated successfully!', ephemeral: true });
            } else {
              await interaction.reply({ content: '❌ Failed to update configuration. Check server logs.', ephemeral: true });
            }
          }

          if (interaction.customId === 'setpayment_modal') {
            const venmo = interaction.fields.getTextInputValue('venmo');
            const zelle = interaction.fields.getTextInputValue('zelle');
            const cashapp = interaction.fields.getTextInputValue('cashapp');
            const crypto = interaction.fields.getTextInputValue('crypto');
            const config = await getBotConfig() || {};
            const newConfig = { ...config, venmo, zelle, cashapp, crypto };
            const success = await updateBotConfig(newConfig);
            if (success) {
              await interaction.reply({ content: '✅ Payment methods updated successfully!', ephemeral: true });
            } else {
              await interaction.reply({ content: '❌ Failed to update payment methods.', ephemeral: true });
            }
          }

          if (interaction.customId === 'branding_modal') {
            const color = interaction.fields.getTextInputValue('color');
            const displayName = interaction.fields.getTextInputValue('displayName');
            const footer = interaction.fields.getTextInputValue('footer');
            const avatar = interaction.fields.getTextInputValue('avatar');
            const status = interaction.fields.getTextInputValue('status');
            
            const config = await getBotConfig() || {};
            const newConfig = { ...config, embedColor: color, botDisplayName: displayName, footerText: footer, avatarUrl: avatar, statusMessage: status };
            const success = await updateBotConfig(newConfig);
            
            let extraMsg = '';
            if (avatar) {
              try {
                await client.user?.setAvatar(avatar);
                extraMsg += '\n✅ Profile picture updated.';
              } catch (e) {
                extraMsg += '\n❌ Failed to update profile picture (invalid URL or rate limited).';
              }
            }
            if (status) {
              client.user?.setActivity(status);
              extraMsg += '\n✅ Status message updated.';
            }
            
            if (success) {
              await interaction.reply({ content: `✅ Branding updated successfully!${extraMsg}`, ephemeral: true });
            } else {
              await interaction.reply({ content: '❌ Failed to update branding.', ephemeral: true });
            }
          }

          if (interaction.customId === 'order_info_modal') {
            const email = interaction.fields.getTextInputValue('email');
            if (!email.toLowerCase().endsWith('@gmail.com')) {
              return await interaction.reply({ content: '❌ Error: Email must be a Gmail address.', ephemeral: true });
            }

            // Validate phone number format (digits, dashes, parens, spaces, optional leading +)
            const rawPhone = interaction.fields.getTextInputValue('phone');
            if (!/^[+]?[\d\s()\-]{7,20}$/.test(rawPhone)) {
              return await interaction.reply({ content: '❌ Error: Please enter a valid phone number.', ephemeral: true });
            }

            orderState.set(interaction.user.id, {
              info: {
                name: sanitizeInput(interaction.fields.getTextInputValue('name'), 100),
                location: sanitizeInput(interaction.fields.getTextInputValue('location'), 200),
                time: sanitizeInput(interaction.fields.getTextInputValue('time'), 50),
                phone: sanitizeInput(rawPhone, 20),
                email: sanitizeInput(email, 100)
              },
              orders: [],
              editingIndex: null,
              lastUpdated: Date.now()
            });

            await showEntreeSelect(interaction, orderState.get(interaction.user.id));
          }
        }

        if (interaction.isStringSelectMenu() || interaction.isButton()) {
          if (interaction.customId.startsWith('admin_')) {
            const config = await getBotConfig() || {};
            const isStaff = config.staffRoleId && interaction.member?.roles && (interaction.member.roles as any).cache.has(config.staffRoleId);
            const isAdmin = interaction.memberPermissions?.has('Administrator');
            if (!isAdmin && !isStaff) {
              return await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true });
            }
            if (interaction.isStringSelectMenu()) {
              if (interaction.customId === 'admin_filter_status') {
                await interaction.deferUpdate();
                await showAdminOrders(interaction, interaction.values[0]);
              } else if (interaction.customId === 'admin_order_select') {
                await interaction.deferUpdate();
                const orderId = interaction.values[0];
                const orderDoc = await getDoc(doc(db, 'orders', orderId));
                const order = orderDoc.data();
                
                const parsedOrders = safeParseOrders(order?.orderData);
                const parsedUserInfo = safeParseUserInfo(order?.userInfo);

                const formattedOrders = formatOrderItems(parsedOrders);

                const config = await getBotConfig() || {};
                const embed = createEmbed(config)
                  .setTitle(`Order Details: ${orderId.slice(0, 8)}`)
                  .addFields(
                    { name: 'Customer', value: parsedUserInfo.name || 'N/A', inline: true },
                    { name: 'Phone', value: parsedUserInfo.phone || 'N/A', inline: true },
                    { name: 'Status', value: order?.status || 'Unknown', inline: true },
                    { name: 'Items', value: formattedOrders || 'No items' }
                  );

                const statusSelect = new StringSelectMenuBuilder()
                  .setCustomId(`admin_status_update_${orderId}`)
                  .setPlaceholder('Update status')
                  .addOptions([
                    { label: 'Pending', value: 'pending' },
                    { label: 'Pending Cash App', value: 'pending_cashapp' },
                    { label: 'Pending Venmo', value: 'pending_venmo' },
                    { label: 'Pending Zelle', value: 'pending_zelle' },
                    { label: 'Pending Crypto', value: 'pending_crypto' },
                    { label: 'Paid', value: 'paid' },
                    { label: 'Fulfilled', value: 'paid_fulfilled' }
                  ]);
                
                const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(statusSelect);
                const backBtn = new ButtonBuilder()
                  .setCustomId('admin_back_to_orders')
                  .setLabel('Back to Orders')
                  .setStyle(ButtonStyle.Secondary);
                const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
                await interaction.editReply({ embeds: [embed], components: [row, row2] });
              } else if (interaction.customId.startsWith('admin_status_update_')) {
                await interaction.deferUpdate();
                const orderId = interaction.customId.replace('admin_status_update_', '');
                const newStatus = interaction.values[0];
                
                const orderRef = doc(db, 'orders', orderId);
                const orderDoc = await getDoc(orderRef);
                const orderData = orderDoc.data();

                const backBtn = new ButtonBuilder()
                  .setCustomId('admin_back_to_orders')
                  .setLabel('Back to Orders')
                  .setStyle(ButtonStyle.Secondary);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

                if (newStatus === 'paid' && orderData?.status !== 'paid' && orderData?.status !== 'paid_fulfilled') {
                  await fulfillOrder(orderId);
                  await interaction.editReply({ content: `✅ Order ${orderId} payment manually confirmed and sent to kitchen.`, embeds: [], components: [row] });
                } else {
                  await updateDoc(orderRef, { status: newStatus });
                  await interaction.editReply({ content: `✅ Order ${orderId} updated to ${newStatus}.`, embeds: [], components: [row] });
                }

                if (orderData?.userId) {
                  try {
                    const user = await client.users.fetch(orderData.userId);
                    let statusMessage = '';
                    if (newStatus === 'paid_fulfilled') {
                      statusMessage = '🎉 Good news! Your order has been fulfilled and is ready for pickup!';
                    } else if (newStatus !== 'paid') {
                      statusMessage = `ℹ️ Your order status has been updated to: ${newStatus}`;
                    }
                    if (statusMessage) {
                      await user.send(statusMessage);
                    }
                  } catch (err) {
                    console.error(`Failed to send DM to user ${orderData.userId}:`, err);
                  }
                }
              }
            } else if (interaction.isButton()) {
              if (interaction.customId === 'admin_back_to_orders') {
                await interaction.deferUpdate();
                await showAdminOrders(interaction, 'pending');
              } else if (interaction.customId.startsWith('admin_confirm_all_')) {
                await interaction.deferUpdate();
                let statusToConfirm = 'pending';
                let paymentName = '';
                
                if (interaction.customId === 'admin_confirm_all_cashapp') {
                  statusToConfirm = 'pending_cashapp';
                  paymentName = 'Cash App ';
                } else if (interaction.customId === 'admin_confirm_all_venmo') {
                  statusToConfirm = 'pending_venmo';
                  paymentName = 'Venmo ';
                } else if (interaction.customId === 'admin_confirm_all_zelle') {
                  statusToConfirm = 'pending_zelle';
                  paymentName = 'Zelle ';
                } else if (interaction.customId === 'admin_confirm_all_crypto') {
                  statusToConfirm = 'pending_crypto';
                  paymentName = 'Crypto ';
                }

                const ordersQuery = query(collection(db, 'orders'), where('status', '==', statusToConfirm));
                const ordersSnapshot = await getDocs(ordersQuery);
                
                let confirmedCount = 0;
                for (const orderDoc of ordersSnapshot.docs) {
                  const orderId = orderDoc.id;
                  
                  await fulfillOrder(orderId);
                  confirmedCount++;
                }
                
                const config = await getBotConfig() || {};
                const embed = createEmbed(config)
                  .setTitle('✅ Mass Confirmation Complete')
                  .setDescription(`Successfully confirmed and sent ${confirmedCount} ${paymentName}order(s) to the kitchen.`);
                  
                const backBtn = new ButtonBuilder()
                  .setCustomId('admin_back_to_orders')
                  .setLabel('Back to Orders')
                  .setStyle(ButtonStyle.Secondary);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
                
                await interaction.editReply({ embeds: [embed], components: [row] });
              } else if (interaction.customId === 'admin_clear_batch') {
                await interaction.deferUpdate();
                const ordersQuery = query(collection(db, 'orders'), where('batchStatus', '==', 'pending'));
                const ordersSnapshot = await getDocs(ordersQuery);
                
                let clearedCount = 0;
                for (const orderDoc of ordersSnapshot.docs) {
                  await updateDoc(doc(db, 'orders', orderDoc.id), { batchStatus: 'cleared' });
                  clearedCount++;
                }
                
                const config = await getBotConfig() || {};
                const embed = createEmbed(config)
                  .setTitle('✅ Batch Cleared')
                  .setDescription(`Successfully cleared ${clearedCount} order(s) from the batch.`);
                  
                await interaction.editReply({ embeds: [embed], components: [] });
              }
            }
            return;
          }

          const state = orderState.get(interaction.user.id);
          if (!state) {
            return await interaction.reply({ content: '❌ Session expired. Please use `/order` again.', ephemeral: true });
          }
          state.lastUpdated = Date.now();

          if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'entree_select') {
              state.currentOrder = { type: interaction.values[0], proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premium: 'None' };
              await showProteinSelect(interaction, state);
            } else if (interaction.customId === 'protein_select') {
              state.currentOrder.proteins = [interaction.values[0]];
              await showProteinPortion(interaction, state);
            } else if (interaction.customId === 'rice_select') {
              state.currentOrder.rice.type = interaction.values[0];
              if (state.currentOrder.rice.type === 'None') {
                await showBeansSelect(interaction, state);
              } else {
                await showRicePortion(interaction, state);
              }
            } else if (interaction.customId === 'beans_select') {
              state.currentOrder.beans.type = interaction.values[0];
              if (state.currentOrder.beans.type === 'None') {
                await showToppingsSelect(interaction, state);
              } else {
                await showBeansPortion(interaction, state);
              }
            } else if (interaction.customId === 'toppings_select') {
              state.currentOrder.selectedToppings = interaction.values;
              if (state.currentOrder.selectedToppings.length > 0) {
                state.toppingIndex = 0;
                state.currentOrder.toppings = [];
                await showToppingPortion(interaction, state, 0);
              } else {
                await showPremiumSelect(interaction, state);
              }
            } else if (interaction.customId === 'premium_select') {
              state.currentOrder.premium = interaction.values[0];
              const isEditing = state.editingIndex !== null && state.editingIndex !== undefined;
              if (isEditing) {
                state.orders.splice(state.editingIndex, 0, state.currentOrder);
                state.editingIndex = null;
              } else {
                state.orders.push(state.currentOrder);
              }
              
              const type = state.currentOrder.type;
              const emoji = type.includes('Bowl') ? '🥗' : (type === 'Tacos' ? '🌮' : '🌯');
              const actionText = isEditing ? 'Updating your' : 'Wrapping your';
              
              await interaction.update({ content: `${emoji} ${actionText} ${type.toLowerCase()}...`, components: [], embeds: [] });
              await new Promise(resolve => setTimeout(resolve, 800));
              await interaction.editReply({ content: `✅ Item ${isEditing ? 'updated' : 'added to cart'}!`, components: [], embeds: [] });
              await new Promise(resolve => setTimeout(resolve, 800));
              
              await showReview(interaction, state);
            } else if (interaction.customId === 'edit_item_select') {
              const index = parseInt(interaction.values[0]);
              state.editingIndex = index;
              const itemToEdit = state.orders.splice(index, 1)[0];
              state.currentOrder = itemToEdit;
              await showEntreeSelect(interaction, state);
            } else if (interaction.customId === 'remove_item_select') {
              const index = parseInt(interaction.values[0]);
              state.orders.splice(index, 1);
              if (state.orders.length === 0) {
                state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premium: 'None' };
                await interaction.update({ content: 'Your cart is now empty. Please add an item.', components: [], embeds: [] });
                await showEntreeSelect(interaction, state);
              } else {
                await showReview(interaction, state);
              }
            }
          } else if (interaction.isButton()) {
            if (interaction.customId === 'protein_double') {
              state.currentOrder.isDouble = true;
              await showRiceSelect(interaction, state);
            } else if (interaction.customId === 'protein_skip') {
              state.currentOrder.isDouble = false;
              await showRiceSelect(interaction, state);
            } else if (interaction.customId.startsWith('rice_portion_')) {
              state.currentOrder.rice.portion = interaction.customId.split('_')[2];
              await showBeansSelect(interaction, state);
            } else if (interaction.customId.startsWith('beans_portion_')) {
              state.currentOrder.beans.portion = interaction.customId.split('_')[2];
              await showToppingsSelect(interaction, state);
            } else if (interaction.customId.startsWith('topping_portion_')) {
              const index = parseInt(interaction.customId.split('_')[2]);
              const portion = interaction.customId.split('_')[3];
              const topping = state.currentOrder.selectedToppings[index];
              state.currentOrder.toppings.push({ type: topping, portion });

              if (index + 1 < state.currentOrder.selectedToppings.length) {
                state.toppingIndex = index + 1;
                await showToppingPortion(interaction, state, index + 1);
              } else {
                await showPremiumSelect(interaction, state);
              }
            } else if (interaction.customId === 'add_more') {
              state.currentOrder = { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premium: 'None' };
              await showEntreeSelect(interaction, state);
            } else if (interaction.customId === 'edit_order_start') {
              await showEditSelect(interaction, state);
            } else if (interaction.customId === 'remove_item_start') {
              await showRemoveSelect(interaction, state);
            } else if (interaction.customId === 'checkout') {
              try {
                await interaction.deferUpdate();

                const config = await getBotConfig() || {};
                const basePrice = config.basePrice || 5.00;
                const bulkPrice = config.bulkPrice;
                const bulkThreshold = config.bulkThreshold;

                // Calculate actual price
                let totalPrice = 0;
                const numEntrees = state.orders.length;
                const currentBasePrice = (bulkPrice && bulkThreshold && numEntrees >= bulkThreshold) ? bulkPrice : basePrice;

                state.orders.forEach((order: any) => {
                  let entreePrice = currentBasePrice;
                  if (order.isDouble) entreePrice += 3;
                  if (order.premium && order.premium !== 'None') entreePrice += 2;
                  totalPrice += entreePrice;
                });

                const orderDataStr = JSON.stringify(state.orders);
                const userInfoStr = JSON.stringify(state.info);

                if (!db) {
                  console.error('❌ Firestore DB is not initialized.');
                  return await interaction.followUp({ content: '❌ Database error. Please contact the administrator.', ephemeral: true });
                }
                console.log('🔍 Firestore DB object:', db);

                // Save order to Firestore first to avoid Stripe metadata limits
                const orderId = generateShortOrderId();
                const orderRef = doc(db, 'orders', orderId);
                await setDoc(orderRef, {
                  userId: interaction.user.id,
                  orderData: orderDataStr,
                  userInfo: userInfoStr,
                  status: 'pending',
                  totalPrice: totalPrice,
                  createdAt: serverTimestamp()
                });

                state.currentOrderId = orderId;
                state.totalPrice = totalPrice;

                const buttons: ButtonBuilder[] = [];
                const stripeBtn = new ButtonBuilder().setCustomId('pay_stripe').setLabel('💳 Pay with Stripe').setStyle(ButtonStyle.Primary);
                buttons.push(stripeBtn);

                if (config.cashappTag) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_cashapp').setLabel('💸 Pay with Cash App').setStyle(ButtonStyle.Success));
                }
                if (config.venmoHandle) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_venmo').setLabel('🔵 Pay with Venmo').setStyle(ButtonStyle.Primary));
                }
                if (config.zelleEmail) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_zelle').setLabel('🟣 Pay with Zelle').setStyle(ButtonStyle.Secondary));
                }
                if (config.cryptoAddress) {
                  buttons.push(new ButtonBuilder().setCustomId('pay_crypto').setLabel('🪙 Pay with Crypto').setStyle(ButtonStyle.Secondary));
                }

                const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back').setStyle(ButtonStyle.Danger);
                
                // Discord limits ActionRow to 5 buttons. If we have more, we need multiple rows.
                const rows: ActionRowBuilder<ButtonBuilder>[] = [];
                let currentRow = new ActionRowBuilder<ButtonBuilder>();
                
                for (const btn of buttons) {
                  if (currentRow.components.length >= 5) {
                    rows.push(currentRow);
                    currentRow = new ActionRowBuilder<ButtonBuilder>();
                  }
                  currentRow.addComponents(btn);
                }
                
                if (currentRow.components.length >= 5) {
                  rows.push(currentRow);
                  currentRow = new ActionRowBuilder<ButtonBuilder>();
                }
                currentRow.addComponents(backBtn);
                rows.push(currentRow);
                
                await interaction.editReply({ 
                  content: `Your order total is **$${totalPrice.toFixed(2)}**.\n\nPlease select your preferred payment method:`, 
                  components: rows 
                });
              } catch (err: any) {
                console.error('Checkout Error:', err);
                if (interaction.deferred || interaction.replied) {
                  await interaction.followUp({ content: `❌ Error creating order: ${err.message}`, ephemeral: true });
                } else {
                  await interaction.reply({ content: `❌ Error creating order: ${err.message}`, ephemeral: true });
                }
              }
            } else if (interaction.customId === 'pay_stripe') {
              try {
                await interaction.deferUpdate();
                const stripe = getStripe();
                if (!stripe) {
                  console.error('❌ Stripe is not configured (missing secret key).');
                  return await interaction.followUp({ content: '❌ Payment system is not configured. Please contact the administrator.', ephemeral: true });
                }

                const session = await stripe.checkout.sessions.create({
                  payment_method_types: ['card'],
                  line_items: [{
                    price_data: {
                      currency: 'usd',
                      product_data: {
                        name: 'Chipotle Order',
                        description: `${state.orders.length} Entree(s)`,
                      },
                      unit_amount: Math.round(state.totalPrice * 100),
                    },
                    quantity: 1,
                  }],
                  mode: 'payment',
                  success_url: 'https://discord.com/channels/@me',
                  cancel_url: 'https://discord.com/channels/@me',
                  client_reference_id: interaction.user.id,
                  metadata: {
                    orderId: state.currentOrderId,
                    userId: interaction.user.id
                  }
                });

                state.stripeSessionId = session.id;
                state.isFulfilled = false;

                const config = await getBotConfig() || {};
                const checkoutMsg = config.checkoutMessage || 'Please pay using the link below. Your order will be sent to the kitchen automatically once payment is confirmed.';

                const payBtn = new ButtonBuilder().setLabel('Pay with Stripe').setStyle(ButtonStyle.Link).setURL(session.url!);
                const checkBtn = new ButtonBuilder().setCustomId('check_payment').setLabel('Check Payment Status').setStyle(ButtonStyle.Primary);
                const refreshBtn = new ButtonBuilder().setCustomId('refresh_link').setLabel('Refresh Link').setStyle(ButtonStyle.Secondary);
                const backBtn = new ButtonBuilder().setCustomId('checkout').setLabel('Back to Payment Options').setStyle(ButtonStyle.Danger);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(payBtn, checkBtn, refreshBtn, backBtn);
                
                await interaction.editReply({ 
                  content: `Total: **$${state.totalPrice.toFixed(2)}**. ${checkoutMsg}\n\n*If the order doesn't process after payment, click "Check Payment Status".*`, 
                  components: [row] 
                });
              } catch (err: any) {
                console.error('Stripe Session Error:', err);
                
                let userMessage = 'Please try again later.';
                if (err.type === 'StripeInvalidRequestError') {
                  userMessage = 'There was an issue with the order details. Please review your cart and try again.';
                } else if (err.type === 'StripeAPIError') {
                  userMessage = 'Stripe is currently experiencing issues. Please try again later.';
                } else if (err.type === 'StripeConnectionError') {
                  userMessage = 'Network issue connecting to the payment provider. Please check your connection and try again.';
                } else if (err.type === 'StripeAuthenticationError') {
                  userMessage = 'Payment system configuration error. Please contact the administrator.';
                } else if (err.message) {
                  userMessage = err.message;
                }

                if (interaction.deferred || interaction.replied) {
                  await interaction.followUp({ content: `❌ Error creating payment session: ${userMessage}`, ephemeral: true });
                } else {
                  await interaction.reply({ content: `❌ Error creating payment session: ${userMessage}`, ephemeral: true });
                }
              }
            } else if (['pay_cashapp', 'pay_venmo', 'pay_zelle', 'pay_crypto'].includes(interaction.customId)) {
              try {
                await interaction.deferUpdate();
                const config = await getBotConfig() || {};
                
                let paymentInfo = '';
                let paymentName = '';
                let statusName = '';
                
                if (interaction.customId === 'pay_cashapp') {
                  if (!config.cashappTag) return await interaction.followUp({ content: '❌ Cash App is not configured.', ephemeral: true });
                  paymentInfo = `**${config.cashappTag}** on Cash App`;
                  paymentName = 'Cash App';
                  statusName = 'cashapp';
                } else if (interaction.customId === 'pay_venmo') {
                  if (!config.venmoHandle) return await interaction.followUp({ content: '❌ Venmo is not configured.', ephemeral: true });
                  paymentInfo = `**${config.venmoHandle}** on Venmo`;
                  paymentName = 'Venmo';
                  statusName = 'venmo';
                } else if (interaction.customId === 'pay_zelle') {
                  if (!config.zelleEmail) return await interaction.followUp({ content: '❌ Zelle is not configured.', ephemeral: true });
                  paymentInfo = `**${config.zelleEmail}** on Zelle`;
                  paymentName = 'Zelle';
                  statusName = 'zelle';
                } else if (interaction.customId === 'pay_crypto') {
                  if (!config.cryptoAddress) return await interaction.followUp({ content: '❌ Crypto is not configured.', ephemeral: true });
                  paymentInfo = `**${config.cryptoAddress}**`;
                  paymentName = 'Crypto';
                  statusName = 'crypto';
                }

                const shortOrderId = state.currentOrderId;
                
                const sentBtn = new ButtonBuilder().setCustomId(`${statusName}_sent`).setLabel('✅ I\'ve Sent the Payment').setStyle(ButtonStyle.Success);
                const backBtn = new ButtonBuilder().setCustomId('checkout').setLabel('Back to Payment Options').setStyle(ButtonStyle.Danger);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(sentBtn, backBtn);

                const embed = createEmbed(config)
                  .setTitle(`💸 Pay with ${paymentName}`)
                  .setDescription(`Please send **$${state.totalPrice.toFixed(2)}** to ${paymentInfo}.\n\n**IMPORTANT:** You MUST include this exact Order Number in the "For" / Notes section of your payment:\n\n\`${shortOrderId}\`\n\nOnce you have sent the payment, click the button below. Your order will be sent to the kitchen as soon as the admin verifies the payment.`);

                await interaction.editReply({ content: '', embeds: [embed], components: [row] });
              } catch (err: any) {
                console.error('Manual Payment Error:', err);
                await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
              }
            } else if (['cashapp_sent', 'venmo_sent', 'zelle_sent', 'crypto_sent'].includes(interaction.customId)) {
              try {
                await interaction.deferUpdate();
                
                let statusName = interaction.customId.replace('_sent', '');
                let paymentName = statusName === 'cashapp' ? 'Cash App' : statusName.charAt(0).toUpperCase() + statusName.slice(1);
                
                const orderRef = doc(db, 'orders', state.currentOrderId);
                await updateDoc(orderRef, { status: `pending_${statusName}` });

                const config = await getBotConfig() || {};
                const embed = createEmbed(config)
                  .setTitle('⏳ Payment Verification Pending')
                  .setDescription(`Thank you! Your order is now awaiting manual verification.\n\nOnce the admin confirms receipt of your ${paymentName} payment with Order Number \`${state.currentOrderId}\`, your order will be sent to the kitchen and you will be notified.`);

                await interaction.editReply({ content: '', embeds: [embed], components: [] });

                // Alert Admin via Webhook
                const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
                if (discordWebhookUrl) {
                  const payload = {
                    content: `🚨 **ACTION REQUIRED: ${paymentName} Payment Pending!** 🚨\n\n**Order ID:** \`${state.currentOrderId}\`\n**Amount:** $${state.totalPrice.toFixed(2)}\n**User:** <@${interaction.user.id}>\n\nPlease check your ${paymentName} for a payment with this Order ID in the notes. Use \`/admin_orders\` to confirm the payment and send the order to the kitchen.`
                  };
                  await fetch(discordWebhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                  }).catch(err => console.error('Failed to send admin alert webhook:', err));
                }

              } catch (err: any) {
                console.error('Payment Sent Error:', err);
                await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
              }
            } else if (interaction.customId === 'refresh_link') {
              if (!state.stripeSessionId) {
                return await interaction.reply({ content: '❌ No active payment session found.', ephemeral: true });
              }

              try {
                await interaction.deferReply({ ephemeral: true });
                const stripe = getStripe();
                if (!stripe) {
                  return await interaction.editReply({ content: '❌ Payment system is not configured.' });
                }
                const session = await stripe.checkout.sessions.retrieve(state.stripeSessionId);
                
                const payBtn = new ButtonBuilder().setLabel('Pay with Stripe').setStyle(ButtonStyle.Link).setURL(session.url!);
                const checkBtn = new ButtonBuilder().setCustomId('check_payment').setLabel('Check Payment Status').setStyle(ButtonStyle.Primary);
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(payBtn, checkBtn);

                await interaction.editReply({ 
                  content: `Here is your payment link again.`, 
                  components: [row] 
                });
              } catch (err) {
                console.error('Refresh Link Error:', err);
                await interaction.editReply({ content: '❌ Error refreshing payment link. Please try again later.' });
              }
            } else if (interaction.customId === 'check_payment') {
              if (!state.currentOrderId) {
                return await interaction.reply({ content: '❌ No active order found.', ephemeral: true });
              }

              try {
                await interaction.deferReply({ ephemeral: true });
                await interaction.editReply({ content: '💳 Verifying payment status...', components: [] });
                await new Promise(resolve => setTimeout(resolve, 800));
                
                const orderId = state.currentOrderId;
                const userId = interaction.user.id;

                let isManuallyConfirmed = false;
                const orderDoc = await getDoc(doc(db, 'orders', orderId));
                const orderData = orderDoc.data();
                if (orderData?.status === 'paid' || orderData?.status === 'paid_fulfilled') {
                  isManuallyConfirmed = true;
                }

                let isStripePaid = false;
                let sessionUrl = null;
                if (state.stripeSessionId) {
                  try {
                    const stripe = getStripe();
                    if (stripe) {
                      const session = await stripe.checkout.sessions.retrieve(state.stripeSessionId);
                      sessionUrl = session.url;
                      if (session.status === 'complete' && session.payment_status === 'paid') {
                        isStripePaid = true;
                      }
                    }
                  } catch (e) {
                    console.error('Error retrieving stripe session:', e);
                  }
                }

                if (state.isFulfilled || isManuallyConfirmed || isStripePaid) {
                  await interaction.editReply({ content: '✅ Payment Confirmed! Sending order to kitchen...', components: [] });
                  await new Promise(resolve => setTimeout(resolve, 800));
                  
                  const success = await fulfillOrder(orderId, false);
                  if (success) {
                    const config = await getBotConfig() || {};
                    const successMsg = config.successMessage || 'Your order has been sent to the kitchen.';
                    
                    const parsedOrders = safeParseOrders(orderData?.orderData);
                    const orderDetails = formatOrderItems(parsedOrders);

                    const successEmbed = createEmbed(config)
                      .setTitle('🎉 Order Successful!')
                      .setDescription(`${successMsg}\n\n**Your Order Details:**\n${orderDetails}`)
                      .setImage('https://media.giphy.com/media/l0HlUxcWRsqROFAHQ/giphy.gif');
                      
                    await interaction.editReply({ content: '', embeds: [successEmbed], components: [] });
                  } else {
                    await interaction.editReply({ content: '❌ Payment confirmed, but there was an error processing your order. Please contact support.', embeds: [] });
                  }
                } else {
                  const components = [];
                  if (sessionUrl) {
                    const payBtn = new ButtonBuilder().setLabel('Pay with Stripe').setStyle(ButtonStyle.Link).setURL(sessionUrl);
                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(payBtn);
                    components.push(row);
                  }
                  await interaction.editReply({ content: '❌ Payment not yet confirmed. If you used Cash App, please wait for an admin to verify your payment.', components, embeds: [] });
                }
              } catch (err) {
                console.error('Check Payment Error:', err);
                await interaction.editReply({ content: '❌ Error checking payment status. Please try again later.' });
              }
            } else if (interaction.customId === 'back_to_review') {
              if (state.editingIndex !== null && state.editingIndex !== undefined) {
                state.orders.splice(state.editingIndex, 0, state.currentOrder);
                state.editingIndex = null;
              }
              await showReview(interaction, state);
            } else if (interaction.customId === 'back_to_entree') {
              await showEntreeSelect(interaction, state);
            } else if (interaction.customId === 'back_to_protein_select') {
              await showProteinSelect(interaction, state);
            } else if (interaction.customId === 'back_to_protein_portion') {
              await showProteinPortion(interaction, state);
            } else if (interaction.customId === 'back_to_rice_select') {
              await showRiceSelect(interaction, state);
            } else if (interaction.customId === 'back_to_rice_portion') {
              await showRicePortion(interaction, state);
            } else if (interaction.customId === 'back_to_beans_select') {
              await showBeansSelect(interaction, state);
            } else if (interaction.customId === 'back_to_beans_portion') {
              await showBeansPortion(interaction, state);
            } else if (interaction.customId === 'back_to_premium') {
              // Only pop from cart if we haven't already restored the current order
              if (!state.currentOrder?.type && state.orders.length > 0) {
                state.currentOrder = state.orders.pop();
              }
              await showPremiumSelect(interaction, state);
            } else if (interaction.customId.startsWith('back_to_topping_')) {
              const index = parseInt(interaction.customId.split('_')[3]);
              await showToppingPortion(interaction, state, index);
            } else if (interaction.customId === 'back_to_toppings_select') {
              await showToppingsSelect(interaction, state);
            }
          }
        }
      } catch (error) {
        console.error('Interaction Error:', error);
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: '❌ An error occurred while processing your request.', ephemeral: true });
          } else {
            await interaction.reply({ content: '❌ An error occurred while processing your request.', ephemeral: true });
          }
        }
      }
    });

    // Login to Discord
    await client.login(token);
  } catch (error) {
    console.error('❌ Failed to initialize Discord bot:', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // IMPORTANT: Stripe webhook must be registered BEFORE express.json()
  // so the raw body is preserved for signature verification.
  app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('--- Webhook Received ---');
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      if (endpointSecret && sig) {
        const stripe = getStripe();
        if (!stripe) {
          console.error('❌ Stripe is not configured. Cannot verify webhook.');
          return res.status(500).send('Stripe not configured.');
        }
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        console.log('Webhook signature verified.');
      } else {
        console.log('No secret/signature, parsing raw body directly.');
        event = JSON.parse(req.body.toString());
      }
    } catch (err: any) {
      console.error(`Webhook Signature Verification Failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: Invalid signature or payload. Please check your Stripe webhook secret.`);
    }

    console.log(`Event Type: ${event.type}`);

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId;

        console.log(`Processing order ID: ${orderId}`);

        if (orderId) {
          const success = await fulfillOrder(orderId);
          if (success) {
            console.log(`Order ${orderId} fulfilled successfully via webhook.`);
          } else {
            console.error(`Failed to fulfill order ${orderId} via webhook. Discord notification or database update may have failed.`);
            // Return 500 to tell Stripe to retry
            return res.status(500).send('Failed to fulfill order. Please retry.');
          }
        } else {
          console.error('Missing orderId in session metadata. Cannot fulfill order.');
          return res.status(400).send('Missing orderId in session metadata.');
        }
      } else {
        console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (err: any) {
      console.error(`Error processing webhook event ${event.type}:`, err);
      return res.status(500).send(`Webhook Processing Error: ${err.message}`);
    }

    res.json({ received: true });
  });

  // Now apply JSON body parser for all other routes
  app.use(express.json());

  // API routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    initDiscordBot();
  });

  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use.`);
      process.exit(1);
    } else {
      console.error('❌ Server error:', e);
    }
  });
}

startServer();


async function handleRevenue(interaction: any) {
  const ordersQuery = query(collection(db, 'orders'), where('status', 'in', ['paid', 'paid_fulfilled']));
  const ordersSnapshot = await getDocs(ordersQuery);
  
  const config = await getBotConfig() || {};
  const basePrice = config.basePrice || 5.00;
  const bulkPrice = config.bulkPrice;
  const bulkThreshold = config.bulkThreshold;
  
  let totalRevenue = 0;
  let totalOrders = 0;
  
  ordersSnapshot.docs.forEach(doc => {
    totalOrders++;
    const orderData = doc.data();
    const parsedOrders = safeParseOrders(orderData.orderData);
    
    const numEntrees = parsedOrders.length;
    const currentBasePrice = (bulkPrice && bulkThreshold && numEntrees >= bulkThreshold) ? bulkPrice : basePrice;

    let orderTotal = 0;
    parsedOrders.forEach((item: any) => {
      orderTotal += currentBasePrice;
      if (item.isDouble) orderTotal += 3;
      if (item.premium !== 'None') orderTotal += 2;
    });
    totalRevenue += orderTotal;
  });

  const embed = createEmbed(config)
    .setTitle('📈 Revenue Report')
    .addFields(
      { name: 'Total Orders', value: `${totalOrders}`, inline: true },
      { name: 'Total Revenue', value: `$${totalRevenue.toFixed(2)}`, inline: true }
    )
    .setFooter({ text: 'Detailed daily/weekly/monthly breakdown coming soon.' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCustomers(interaction: any) {
  const ordersQuery = query(collection(db, 'orders'));
  const ordersSnapshot = await getDocs(ordersQuery);
  
  const customerCounts = new Map<string, number>();
  
  ordersSnapshot.docs.forEach(doc => {
    const userId = doc.data().userId;
    if (userId) {
      customerCounts.set(userId, (customerCounts.get(userId) || 0) + 1);
    }
  });

  const sortedCustomers = Array.from(customerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle('🏆 Top Customers');

  if (sortedCustomers.length === 0) {
    embed.setDescription('No customers found.');
  } else {
    let description = '';
    sortedCustomers.forEach(([userId, count], index) => {
      description += `**${index + 1}.** <@${userId}> - ${count} orders\n`;
    });
    embed.setDescription(description);
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAnnouncements(interaction: any) {
  const message = interaction.options.getString('message');
  const title = interaction.options.getString('title');
  const channel = interaction.options.getChannel('channel');
  const webhookUrl = interaction.options.getString('webhook_url');
  const imageUrl = interaction.options.getString('image_url');

  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setDescription(message);
    
  if (title) embed.setTitle(title);
  if (imageUrl) embed.setImage(imageUrl);

  try {
    if (webhookUrl) {
      if (!isValidDiscordWebhookUrl(webhookUrl)) {
        return await interaction.reply({ content: '❌ Invalid webhook URL. Must be a Discord webhook URL (https://discord.com/api/webhooks/...).', ephemeral: true });
      }
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
      if (!response.ok) throw new Error(`Webhook failed: ${response.statusText}`);
      await interaction.reply({ content: '✅ Announcement sent via webhook!', ephemeral: true });
    } else if (channel) {
      if (typeof channel.send !== 'function') {
         return await interaction.reply({ content: '❌ Please select a valid text channel.', ephemeral: true });
      }
      await channel.send({ embeds: [embed] });
      await interaction.reply({ content: `✅ Announcement sent to ${channel}!`, ephemeral: true });
    } else {
      // Default to the current channel if neither is provided
      await interaction.channel.send({ embeds: [embed] });
      await interaction.reply({ content: '✅ Announcement sent to this channel!', ephemeral: true });
    }
  } catch (error) {
    console.error('Error sending announcement:', error);
    await interaction.reply({ content: '❌ Failed to send announcement. Please check the channel permissions or webhook URL.', ephemeral: true });
  }
}

async function handleFulfillAll(interaction: any) {
  try {
    await interaction.deferReply({ ephemeral: true });
    
    const ordersQuery = query(collection(db, 'orders'), where('status', '==', 'paid'));
    const ordersSnapshot = await getDocs(ordersQuery);
    
    if (ordersSnapshot.empty) {
      return await interaction.editReply({ content: 'No paid orders found to fulfill.' });
    }

    let fulfilledCount = 0;
    for (const orderDoc of ordersSnapshot.docs) {
      const orderData = orderDoc.data();
      await updateDoc(doc(db, 'orders', orderDoc.id), { status: 'paid_fulfilled' });
      fulfilledCount++;
      
      if (orderData?.userId) {
        try {
          const user = await client.users.fetch(orderData.userId);
          await user.send('🎉 Good news! Your order has been fulfilled and is ready for pickup!');
        } catch (err) {
          console.error(`Failed to send DM to user ${orderData.userId}:`, err);
        }
      }
    }

    await interaction.editReply({ content: `✅ Successfully fulfilled ${fulfilledCount} paid order(s).` });
  } catch (error) {
    console.error('Error fulfilling all orders:', error);
    await interaction.editReply({ content: '❌ An error occurred while fulfilling orders.' });
  }
}

async function handleSetPrice(interaction: any) {
  const standard = interaction.options.getNumber('standard');
  const bulkPrice = interaction.options.getNumber('bulk_price');
  const bulkThreshold = interaction.options.getInteger('bulk_threshold');
  
  const config = await getBotConfig() || {};
  const newConfig: any = { ...config, basePrice: standard };
  if (bulkPrice !== null) newConfig.bulkPrice = bulkPrice;
  if (bulkThreshold !== null) newConfig.bulkThreshold = bulkThreshold;
  
  const success = await updateBotConfig(newConfig);
  if (success) {
    let msg = `✅ Standard price updated to **$${standard.toFixed(2)}**.`;
    if (bulkPrice && bulkThreshold) {
      msg += `\n✅ Bulk pricing enabled: **$${bulkPrice.toFixed(2)}** each at **${bulkThreshold}+** entrees.`;
    }
    await interaction.reply({ content: msg, ephemeral: true });
  } else {
    await interaction.reply({ content: '❌ Failed to update price.', ephemeral: true });
  }
}

async function handleSetPayment(interaction: any) {
  const modal = new ModalBuilder()
    .setCustomId('setpayment_modal')
    .setTitle('Update Payment Methods');

  const venmoInput = new TextInputBuilder()
    .setCustomId('venmo')
    .setLabel('Venmo Username')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const zelleInput = new TextInputBuilder()
    .setCustomId('zelle')
    .setLabel('Zelle Email/Phone')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const cashappInput = new TextInputBuilder()
    .setCustomId('cashapp')
    .setLabel('CashApp Tag')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const cryptoInput = new TextInputBuilder()
    .setCustomId('crypto')
    .setLabel('Crypto Address (if enabled)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(venmoInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(zelleInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(cashappInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(cryptoInput)
  );

  await interaction.showModal(modal);
}

async function handleBranding(interaction: any) {
  const modal = new ModalBuilder()
    .setCustomId('branding_modal')
    .setTitle('Update Branding');

  const colorInput = new TextInputBuilder()
    .setCustomId('color')
    .setLabel('Embed Color (Hex, e.g., #FF6321)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const nameInput = new TextInputBuilder()
    .setCustomId('displayName')
    .setLabel('Bot Display Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const footerInput = new TextInputBuilder()
    .setCustomId('footer')
    .setLabel('Footer Text')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const avatarInput = new TextInputBuilder()
    .setCustomId('avatar')
    .setLabel('Profile Picture URL')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const statusInput = new TextInputBuilder()
    .setCustomId('status')
    .setLabel('Bot Status Message')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(colorInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(nameInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(footerInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(avatarInput),
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(statusInput)
  );

  await interaction.showModal(modal);
}

async function handleStoreStatus(interaction: any) {
  await interaction.deferReply({ ephemeral: true });
  const config = await getBotConfig() || {};
  const currentStatus = config.storeOpen !== false; // Default is true
  const newStatus = !currentStatus;
  
  await updateBotConfig({ ...config, storeOpen: newStatus });
  
  let channelMsg = '';
  try {
    const channelId = config.statusChannelId;
    if (channelId) {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel && 'setName' in channel) {
        await (channel as any).setName(newStatus ? '🟢open🟢' : '🔴closed🔴');
        channelMsg = ' and channel name updated';
      }
    } else {
      channelMsg = ' (no status channel configured — use `/settings` to set one)';
    }
  } catch (error) {
    console.error('Failed to rename channel:', error);
    channelMsg = ' (failed to update channel name - check permissions or rate limits)';
  }
  
  await interaction.editReply({ 
    content: `✅ The store is now **${newStatus ? 'OPEN' : 'CLOSED'}**${channelMsg}.`
  });
}

async function handleExport(interaction: any) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const ordersQuery = query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(1000));
    const ordersSnapshot = await getDocs(ordersQuery);
    
    if (ordersSnapshot.empty) {
      return await interaction.editReply({ content: 'No orders found to export.' });
    }

    let csvContent = 'Order ID,User ID,Status,Total Price,Created At,Name,Location,Time,Phone,Email,Order Details\n';
    
    ordersSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const parsedOrders = safeParseOrders(data.orderData);
      const parsedUserInfo = safeParseUserInfo(data.userInfo);
      
      const orderDetails = parsedOrders.map((o: any) => `${o.type} (${(o.proteins || []).join(', ')})`).join('; ');
      const dateStr = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : 'N/A';
      
      const row = [
        doc.id,
        data.userId || 'N/A',
        data.status || 'N/A',
        data.totalPrice || 0,
        dateStr,
        parsedUserInfo.name || 'N/A',
        parsedUserInfo.location || 'N/A',
        parsedUserInfo.time || 'N/A',
        parsedUserInfo.phone || 'N/A',
        parsedUserInfo.email || 'N/A',
        orderDetails
      ].map(field => `"${String(field).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`).join(',');
      
      csvContent += row + '\n';
    });

    const buffer = Buffer.from(csvContent, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: 'orders_export.csv' });
    
    await interaction.editReply({ content: '✅ Here is your orders export:', files: [attachment] });
  } catch (error) {
    console.error('Error exporting orders:', error);
    await interaction.editReply({ content: '❌ Failed to export orders.' });
  }
}

async function handleMenu(interaction: any) {
  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle('🌯 Chipotle Menu')
    .setDescription('Here is what we offer! Use `/order` to start your order.')
    .addFields(
      { name: 'Entrees', value: 'Burrito Bowl, Burrito, Quesadilla, Salad Bowl, Tacos' },
      { name: 'Proteins', value: 'Chicken, Steak, Beef Barbacoa, Carnitas, Sofritas, Veggie' },
      { name: 'Rice & Beans', value: 'White Rice, Brown Rice\nBlack Beans, Pinto Beans' },
      { name: 'Toppings', value: 'Fajita Veggies, Fresh Tomato Salsa, Roasted Chili-Corn Salsa, Tomatillo-Green Chili Salsa, Tomatillo-Red Chili Salsa, Sour Cream, Cheese, Romaine Lettuce' },
      { name: 'Premiums', value: 'Guacamole, Queso Blanco' }
    );
    
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleToggle(interaction: any) {
  const config = await getBotConfig() || {};
  const currentStatus = config.storeOpen !== false; // Default is true (open)
  const newStatus = !currentStatus;
  
  const success = await updateBotConfig({ ...config, storeOpen: newStatus });
  if (success) {
    const emoji = newStatus ? '🟢' : '🔴';
    await interaction.reply({ content: `${emoji} Ordering is now **${newStatus ? 'ENABLED' : 'DISABLED'}**.`, ephemeral: true });
  } else {
    await interaction.reply({ content: '❌ Failed to toggle ordering status.', ephemeral: true });
  }
}

async function handleSettings(interaction: any) {
  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle('⚙️ Bot Settings')
    .setDescription('Use the following commands to configure the bot:\n\n`/config` - Update bot messages\n`/cashapp` - Set Cash App tag\n`/setpayment` - Set other payment methods\n`/setprice` - Update base price\n`/branding` - Update colors and text\n`/toggle` - Enable/disable ordering');
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBlacklist(interaction: any) {
  const user = interaction.options.getUser('user');
  try {
    const blacklistRef = doc(db, 'blacklist', user.id);
    const blacklistDoc = await getDoc(blacklistRef);
    
    if (blacklistDoc.exists()) {
      // User is currently blacklisted — unblock them
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(blacklistRef);
      await interaction.reply({ content: `✅ User **${user.tag}** has been **removed** from the blacklist.`, ephemeral: true });
    } else {
      // Add user to blacklist
      await setDoc(blacklistRef, {
        username: user.tag,
        blockedAt: serverTimestamp()
      });
      await interaction.reply({ content: `🚫 User **${user.tag}** has been **blacklisted**. They will no longer be able to place orders.`, ephemeral: true });
    }
  } catch (err) {
    console.error('Blacklist error:', err);
    await interaction.reply({ content: '❌ Failed to update blacklist.', ephemeral: true });
  }
}

async function showAdminOrders(interaction: any, status: string) {
  const ordersQuery = query(collection(db, 'orders'), where('status', '==', status));
  const ordersSnapshot = await getDocs(ordersQuery);
  const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle(`Orders - ${status.toUpperCase()}`)
    .setDescription(orders.length > 0 ? `Found ${orders.length} orders.` : 'No orders found.');

  const filterSelect = new StringSelectMenuBuilder()
    .setCustomId('admin_filter_status')
    .setPlaceholder('Filter by status')
    .addOptions([
      { label: 'Pending', value: 'pending' },
      { label: 'Pending Cash App', value: 'pending_cashapp' },
      { label: 'Pending Venmo', value: 'pending_venmo' },
      { label: 'Pending Zelle', value: 'pending_zelle' },
      { label: 'Pending Crypto', value: 'pending_crypto' },
      { label: 'Paid', value: 'paid' },
      { label: 'Fulfilled', value: 'paid_fulfilled' }
    ]);

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(filterSelect);
  const components: any[] = [row1];

  if (orders.length > 0) {
    const orderSelect = new StringSelectMenuBuilder()
      .setCustomId('admin_order_select')
      .setPlaceholder('Select an order to manage')
      .addOptions(
        orders.map((order: any) => ({
          label: `Order ${order.id.slice(0, 8)}`,
          description: `Status: ${order.status}`,
          value: order.id
        }))
      );
    const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(orderSelect);
    components.push(row2);
  }

  if (status.startsWith('pending') && orders.length > 0) {
    let btnId = 'admin_confirm_all_pending';
    let btnLabel = 'Confirm All Pending Orders';
    
    if (status === 'pending_cashapp') {
      btnId = 'admin_confirm_all_cashapp';
      btnLabel = 'Confirm All Cash App Orders';
    } else if (status === 'pending_venmo') {
      btnId = 'admin_confirm_all_venmo';
      btnLabel = 'Confirm All Venmo Orders';
    } else if (status === 'pending_zelle') {
      btnId = 'admin_confirm_all_zelle';
      btnLabel = 'Confirm All Zelle Orders';
    } else if (status === 'pending_crypto') {
      btnId = 'admin_confirm_all_crypto';
      btnLabel = 'Confirm All Crypto Orders';
    }

    const confirmAllBtn = new ButtonBuilder()
      .setCustomId(btnId)
      .setLabel(btnLabel)
      .setStyle(ButtonStyle.Success);
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmAllBtn);
    components.push(row3);
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components });
  } else {
    await interaction.reply({ embeds: [embed], components, ephemeral: true });
  }
}

async function fulfillOrder(orderId: string, notifyUser: boolean = true) {
  try {
    const orderRef = doc(db, 'orders', orderId);

    // Use a transaction to atomically check and update status,
    // preventing double-fulfillment from concurrent calls.
    const orderData = await runTransaction(db, async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists()) {
        throw new Error(`Order ${orderId} not found in Firestore.`);
      }

      const data = orderDoc.data();
      if (data?.status === 'paid' || data?.status === 'paid_fulfilled') {
        // Already fulfilled — return null to signal no action needed
        return null;
      }

      // Atomically mark as paid inside the transaction
      transaction.update(orderRef, {
        status: 'paid',
        batchStatus: 'pending',
        paidAt: serverTimestamp()
      });

      return data;
    });

    // Already fulfilled
    if (orderData === null) {
      console.log(`Order ${orderId} already fulfilled.`);
      return true;
    }

    const userId = orderData?.userId;
    const state = orderState.get(userId);
    const parsedOrders = safeParseOrders(orderData?.orderData);
    const parsedUserInfo = safeParseUserInfo(orderData?.userInfo);
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

    if (discordWebhookUrl) {
      const payloadText = formatConfirmedOrderPayload(userId, parsedUserInfo, parsedOrders);

      const payload = {
        content: `**✅ Payment Confirmed! New Chipotle Order!**\n\n${payloadText}`
      };

      const response = await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        console.log(`Order successfully sent to Discord Webhook for user ${userId}.`);
        if (state) state.isFulfilled = true;
        
        // Notify the user
        if (notifyUser) {
          try {
            const user = await client.users.fetch(userId);
            if (user) {
              await user.send(`✅ Your payment has been confirmed. We are preparing your order!\n\n**Your Order Details:**\n${payloadText}`);
            }
          } catch (e) {
            console.error(`Could not send DM to user ${userId}`, e);
          }
        }
        
        // Clean up state
        orderState.delete(userId);
        
        return true;
      } else {
        console.error(`Discord Webhook failed with status: ${response.status}`);
        return false;
      }
    } else {
      console.error('DISCORD_WEBHOOK_URL is not defined.');
      return false;
    }
  } catch (err) {
    console.error('Error in fulfillOrder:', err);
    return false;
  }
}












function createPortionRow(prefix: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_Light`).setLabel('Light').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}_Regular`).setLabel('Regular').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}_Extra`).setLabel('Extra').setStyle(ButtonStyle.Secondary),
  );
}

async function showEntreeSelect(interaction: any, state: any) {
  const config = await getBotConfig() || {};
  const entreePrompt = config.entreePrompt || 'Choose your entree:';

  const select = new StringSelectMenuBuilder()
    .setCustomId('entree_select')
    .setPlaceholder('Choose your entree')
    .addOptions(
      { label: 'Burrito Bowl', value: 'Burrito Bowl' },
      { label: 'Burrito', value: 'Burrito' },
      { label: 'Quesadilla', value: 'Quesadilla' },
      { label: 'Salad Bowl', value: 'Salad Bowl' },
      { label: 'Tacos', value: 'Tacos' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  
  const components: any[] = [row];
  if (state.orders && state.orders.length > 0) {
    const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Danger);
    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
    components.push(backRow);
  }

  const method = interaction.replied || interaction.deferred ? 'editReply' : (interaction.isButton() || interaction.isStringSelectMenu() ? 'update' : 'reply');
  await interaction[method]({ content: entreePrompt, components, embeds: [], ephemeral: true });
}

async function showProteinSelect(interaction: any, state: any) {
  const config = await getBotConfig() || {};
  const proteinPrompt = config.proteinPrompt || 'Now choose your protein:';

  const select = new StringSelectMenuBuilder()
    .setCustomId('protein_select')
    .setPlaceholder('Choose Protein or Veggie')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: 'Chicken', value: 'Chicken' },
      { label: 'Steak', value: 'Steak' },
      { label: 'Beef Barbacoa', value: 'Beef Barbacoa' },
      { label: 'Carnitas', value: 'Carnitas' },
      { label: 'Sofritas', value: 'Sofritas' },
      { label: 'Veggie', value: 'Veggie' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backBtn = new ButtonBuilder().setCustomId('back_to_entree').setLabel('Back').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
  await interaction.update({ content: `Selected: **${state.currentOrder.type}**. ${proteinPrompt}`, components: [row, backRow] });
}

async function showProteinPortion(interaction: any, state: any) {
  const doubleBtn = new ButtonBuilder().setCustomId('protein_double').setLabel('Double Protein').setStyle(ButtonStyle.Primary);
  const skipBtn = new ButtonBuilder().setCustomId('protein_skip').setLabel('Regular Portion').setStyle(ButtonStyle.Secondary);
  const backBtn = new ButtonBuilder().setCustomId('back_to_protein_select').setLabel('Back').setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(doubleBtn, skipBtn, backBtn);
  await interaction.update({ content: `Proteins: **${state.currentOrder.proteins.join(', ')}**. Double protein?`, components: [row] });
}

async function showRiceSelect(interaction: any, state: any) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('rice_select')
    .setPlaceholder('Choose Rice')
    .addOptions(
      { label: 'White Rice', value: 'White Rice' },
      { label: 'Brown Rice', value: 'Brown Rice' },
      { label: 'None', value: 'None' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backBtn = new ButtonBuilder().setCustomId('back_to_protein_portion').setLabel('Back').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
  await interaction.update({ content: 'Choose your rice:', components: [row, backRow] });
}

async function showRicePortion(interaction: any, state: any) {
  const row = createPortionRow('rice_portion');
  const backBtn = new ButtonBuilder().setCustomId('back_to_rice_select').setLabel('Back').setStyle(ButtonStyle.Danger);
  row.addComponents(backBtn);
  await interaction.update({ content: `Rice: **${state.currentOrder.rice.type}**. Choose portion:`, components: [row] });
}

async function showBeansSelect(interaction: any, state: any) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('beans_select')
    .setPlaceholder('Choose Beans')
    .addOptions(
      { label: 'Black Beans', value: 'Black Beans' },
      { label: 'Pinto Beans', value: 'Pinto Beans' },
      { label: 'None', value: 'None' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backId = state.currentOrder.rice.type === 'None' ? 'back_to_rice_select' : 'back_to_rice_portion';
  const backBtn = new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
  await interaction.update({ content: 'Choose your beans:', components: [row, backRow] });
}

async function showBeansPortion(interaction: any, state: any) {
  const row = createPortionRow('beans_portion');
  const backBtn = new ButtonBuilder().setCustomId('back_to_beans_select').setLabel('Back').setStyle(ButtonStyle.Danger);
  row.addComponents(backBtn);
  await interaction.update({ content: `Beans: **${state.currentOrder.beans.type}**. Choose portion:`, components: [row] });
}

async function showToppingsSelect(interaction: any, state: any) {
  const entreeType = state.currentOrder.type;
  let maxToppings = 8;
  if (entreeType === 'Quesadilla') maxToppings = 2;
  if (entreeType === 'Tacos') maxToppings = 4;

  const select = new StringSelectMenuBuilder()
    .setCustomId('toppings_select')
    .setPlaceholder('Choose Toppings')
    .setMinValues(0)
    .setMaxValues(maxToppings)
    .addOptions(
      { label: 'Fresh Tomato Salsa', value: 'Fresh Tomato Salsa' },
      { label: 'Roasted Chili-Corn Salsa', value: 'Roasted Chili-Corn Salsa' },
      { label: 'Tomatillo-Green Chili Salsa', value: 'Tomatillo-Green Chili Salsa' },
      { label: 'Tomatillo-Red Chili Salsa', value: 'Tomatillo-Red Chili Salsa' },
      { label: 'Sour Cream', value: 'Sour Cream' },
      { label: 'Fajita Veggies', value: 'Fajita Veggies' },
      { label: 'Cheese', value: 'Cheese' },
      { label: 'Romaine Lettuce', value: 'Romaine Lettuce' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backId = state.currentOrder.beans.type === 'None' ? 'back_to_beans_select' : 'back_to_beans_portion';
  const backBtn = new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
  await interaction.update({ content: 'Choose your toppings:', components: [row, backRow] });
}

async function showToppingPortion(interaction: any, state: any, index: number) {
  const topping = state.currentOrder.selectedToppings[index];
  const row = createPortionRow(`topping_portion_${index}`);
  const backId = index === 0 ? 'back_to_toppings_select' : `back_to_topping_${index - 1}`;
  const backBtn = new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger);
  row.addComponents(backBtn);
  await interaction.update({ content: `Topping: **${topping}**. Choose portion:`, components: [row] });
}

async function showPremiumSelect(interaction: any, state: any) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('premium_select')
    .setPlaceholder('Choose Premium Topping')
    .addOptions(
      { label: 'Guacamole', value: 'Guacamole' },
      { label: 'Queso', value: 'Queso' },
      { label: 'None', value: 'None' },
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backId = state.currentOrder.selectedToppings.length === 0 ? 'back_to_toppings_select' : `back_to_topping_${state.currentOrder.selectedToppings.length - 1}`;
  const backBtn = new ButtonBuilder().setCustomId(backId).setLabel('Back').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);
  await interaction.update({ content: 'Choose one premium topping (optional):', components: [row, backRow] });
}

async function showReview(interaction: any, state: any) {
  const config = await getBotConfig() || {};
  const basePrice = config.basePrice || 5.00;
  const bulkPrice = config.bulkPrice;
  const bulkThreshold = config.bulkThreshold;

  const numEntrees = state.orders.length;
  const currentBasePrice = (bulkPrice && bulkThreshold && numEntrees >= bulkThreshold) ? bulkPrice : basePrice;

  const embed = createEmbed(config)
    .setTitle('🛒 Your Order Summary')
    .setDescription(`You have **${numEntrees}** item(s) in your cart. Review your selection below before proceeding to checkout.`);

  let grandTotal = 0;

  state.orders.forEach((order: any, i: number) => {
    let itemPrice = currentBasePrice;
    if (order.isDouble) itemPrice += 3;
    if (order.premium && order.premium !== 'None') itemPrice += 2;

    const proteinStr = order.isDouble ? `Double ${order.proteins[0]}` : order.proteins[0] || 'Veggie';
    
    let optionsStr = `**Protein:** ${proteinStr}\n`;
    optionsStr += `**Rice:** ${order.rice.portion && order.rice.portion !== 'Regular' ? `${order.rice.portion} ` : ''}${order.rice.type}\n`;
    optionsStr += `**Beans:** ${order.beans.portion && order.beans.portion !== 'Regular' ? `${order.beans.portion} ` : ''}${order.beans.type}\n`;
    
    if (order.toppings && order.toppings.length > 0) {
      const toppingsList = order.toppings.map((t: any) => t.portion === 'Regular' ? `${t.type}` : `${t.portion} ${t.type}`).join(', ');
      optionsStr += `**Toppings:** ${toppingsList}\n`;
    }

    if (order.premium && order.premium !== 'None') {
      optionsStr += `**Premium:** ${order.premium}\n`;
    }

    if (order.isDouble) {
      optionsStr += `*(Double Protein)*\n`;
    }

    optionsStr += `**Item Total: $${itemPrice.toFixed(2)}**`;
    grandTotal += itemPrice;

    embed.addFields({ 
      name: `${i + 1}. ${order.type}`, 
      value: optionsStr
    });
  });

  embed.addFields({
    name: '━━━━━━━━━━━━━━━━━━━━━━━━',
    value: `### **Total Amount: $${grandTotal.toFixed(2)}**`
  });

  const addBtn = new ButtonBuilder().setCustomId('add_more').setLabel('➕ Add More Items').setStyle(ButtonStyle.Secondary);
  const editBtn = new ButtonBuilder().setCustomId('edit_order_start').setLabel('✏️ Edit Order').setStyle(ButtonStyle.Primary);
  const removeBtn = new ButtonBuilder().setCustomId('remove_item_start').setLabel('🗑️ Remove Item').setStyle(ButtonStyle.Danger);
  const checkoutBtn = new ButtonBuilder().setCustomId('checkout').setLabel('💳 Proceed to Checkout').setStyle(ButtonStyle.Success);
  const backBtn = new ButtonBuilder().setCustomId('back_to_premium').setLabel('Back').setStyle(ButtonStyle.Secondary);
  
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(addBtn, editBtn, removeBtn, checkoutBtn, backBtn);
  
  const method = interaction.replied || interaction.deferred ? 'editReply' : 'update';
  await interaction[method]({ content: '', embeds: [embed], components: [row] });
}

async function showEditSelect(interaction: any, state: any) {
  if (state.orders.length === 0) {
    return await interaction.reply({ content: '❌ Your cart is empty.', ephemeral: true });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('edit_item_select')
    .setPlaceholder('Select an item to edit')
    .addOptions(
      state.orders.map((order: any, i: number) => ({
        label: `${i + 1}. ${order.type}`,
        description: `${order.proteins[0] || 'Veggie'} - $1.00`,
        value: i.toString()
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Danger);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

  await interaction.update({ content: 'Which item would you like to edit?', components: [row, backRow], embeds: [] });
}

async function showRemoveSelect(interaction: any, state: any) {
  if (state.orders.length === 0) {
    return await interaction.reply({ content: '❌ Your cart is empty.', ephemeral: true });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('remove_item_select')
    .setPlaceholder('Select an item to remove')
    .addOptions(
      state.orders.map((order: any, i: number) => ({
        label: `${i + 1}. ${order.type}`,
        description: `${order.proteins[0] || 'Veggie'} - $1.00`,
        value: i.toString()
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const backBtn = new ButtonBuilder().setCustomId('back_to_review').setLabel('Back to Review').setStyle(ButtonStyle.Secondary);
  const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn);

  await interaction.update({ content: 'Which item would you like to remove?', components: [row, backRow], embeds: [] });
}

async function showAdminBatch(interaction: any) {
  const ordersQuery = query(collection(db, 'orders'), where('batchStatus', '==', 'pending'));
  const ordersSnapshot = await getDocs(ordersQuery);
  const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  if (orders.length === 0) {
    return await interaction.reply({ content: 'No orders in the current batch.', ephemeral: true });
  }

  let batchDetails = '';
  orders.forEach((order: any) => {
    const parsedOrders = safeParseOrders(order.orderData);
    const parsedUserInfo = safeParseUserInfo(order.userInfo);
    
    const orderText = `**Order ID:** ${order.id.slice(0, 8)}\n${formatConfirmedOrderPayload(order.userId, parsedUserInfo, parsedOrders)}\n\n`;
    if (batchDetails.length + orderText.length < 4000) {
      batchDetails += orderText;
    } else if (!batchDetails.endsWith('...')) {
      batchDetails += '... (some orders omitted due to length limit)';
    }
  });

  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle(`Current Order Batch (${orders.length} Orders)`)
    .setDescription(batchDetails);

  const clearBtn = new ButtonBuilder()
    .setCustomId('admin_clear_batch')
    .setLabel('Clear Batch')
    .setStyle(ButtonStyle.Danger);
    
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(clearBtn);

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else {
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }
}

async function handleReorder(interaction: any) {
  const ordersQuery = query(collection(db, 'orders'), where('userId', '==', interaction.user.id), orderBy('createdAt', 'desc'), limit(1));
  const ordersSnapshot = await getDocs(ordersQuery);
  
  if (ordersSnapshot.empty) {
    return await interaction.reply({ content: '❌ You have no previous orders to reorder.', ephemeral: true });
  }
  
  const lastOrder = ordersSnapshot.docs[0].data();
  const parsedOrders = safeParseOrders(lastOrder.orderData);
  const parsedUserInfo = safeParseUserInfo(lastOrder.userInfo);
  
  orderState.set(interaction.user.id, {
    orders: parsedOrders,
    info: parsedUserInfo,
    currentOrder: { type: '', proteins: [], rice: { type: 'None' }, beans: { type: 'None' }, toppings: [], selectedToppings: [], premium: 'None' },
    lastUpdated: Date.now()
  });
  
  if (interaction.replied || interaction.deferred) {
    await showReview(interaction, orderState.get(interaction.user.id));
  } else {
    await interaction.deferReply({ ephemeral: true });
    await showReview(interaction, orderState.get(interaction.user.id));
  }
}

async function handleMyOrders(interaction: any) {
  const ordersQuery = query(collection(db, 'orders'), where('userId', '==', interaction.user.id), orderBy('createdAt', 'desc'), limit(5));
  const ordersSnapshot = await getDocs(ordersQuery);
  
  if (ordersSnapshot.empty) {
    return await interaction.reply({ content: '❌ You have no recent orders.', ephemeral: true });
  }
  
  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle('Your Recent Orders');
    
  ordersSnapshot.docs.forEach((doc, i) => {
    const order = doc.data();
    let status = 'Pending';
    if (order.status === 'paid_fulfilled') status = 'Fulfilled';
    else if (order.status === 'paid') status = 'Paid (Preparing)';
    else if (order.status === 'pending_cashapp') status = 'Pending Cash App';
    else if (order.status === 'pending_venmo') status = 'Pending Venmo';
    else if (order.status === 'pending_zelle') status = 'Pending Zelle';
    else if (order.status === 'pending_crypto') status = 'Pending Crypto';
    
    const parsedOrders = safeParseOrders(order.orderData);
    const itemsOrdered = parsedOrders.map((o: any) => o.type).join(', ') || 'No items';
    const totalCost = order.totalPrice ? `$${order.totalPrice.toFixed(2)}` : 'N/A';
    
    embed.addFields({ 
      name: `Order ${doc.id.slice(0, 8)}`, 
      value: `**Status:** ${status}\n**Date:** ${order.createdAt?.toDate().toLocaleString() || 'Unknown'}\n**Items:** ${itemsOrdered}\n**Total:** ${totalCost}` 
    });
  });
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleWallet(interaction: any) {
  await interaction.reply({ content: '💳 **Wallet**\n\nThe credits/wallet system is not yet available. Stay tuned for updates!', ephemeral: true });
}

async function handleSupport(interaction: any) {
  await interaction.reply({ content: '🛠️ **Need Help?**\n\nPlease open a ticket in the designated support channel or contact an administrator.', ephemeral: true });
}

async function handleHelp(interaction: any) {
  const config = await getBotConfig() || {};
  const embed = createEmbed(config)
    .setTitle('🌯 Chipotle Bot Help')
    .setDescription('Welcome to the Chipotle Bot! Here is how you can use it:')
    .addFields(
      { name: '`/order`', value: 'Start a new order. You will be prompted for your contact info and then you can build your meal.' },
      { name: '`/reorder`', value: 'Quickly repeat your last order.' },
      { name: '`/myorders`', value: 'Check the status of your recent orders.' },
      { name: '`/wallet`', value: 'Check your current credit balance.' },
      { name: '`/support`', value: 'Get help if you have an issue with your order.' }
    );
    
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
