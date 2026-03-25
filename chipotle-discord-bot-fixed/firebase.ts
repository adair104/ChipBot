import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp as fsServerTimestamp } from 'firebase/firestore';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔥 Initializing Firebase Client module...');

let firebaseConfig: any = {};
const configPath = join(__dirname, 'firebase-applet-config.json');

try {
  if (existsSync(configPath)) {
    firebaseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    console.log('✅ Firebase config loaded.');
  } else {
    console.warn('⚠️ firebase-applet-config.json not found at', configPath);
  }
} catch (err) {
  console.error('❌ Error parsing firebase-applet-config.json:', err);
}

// Initialize Firebase Client SDK
let app;
if (firebaseConfig.projectId) {
  try {
    if (!getApps().length) {
      app = initializeApp(firebaseConfig);
      console.log('✅ Firebase Client initialized with projectId:', firebaseConfig.projectId);
    } else {
      app = getApp();
    }
  } catch (err) {
    console.error('❌ Firebase Client initialization failed:', err);
  }
} else {
  console.warn('⚠️ Skipping Firebase Client initialization: No projectId found.');
}

// Use the specific database ID from config
console.log('🔍 Initializing Firestore with databaseId:', firebaseConfig.firestoreDatabaseId);
export const db = firebaseConfig.projectId && app ? getFirestore(app, firebaseConfig.firestoreDatabaseId) : null as any;
if (db) {
  console.log('✅ Firestore DB initialized.');
} else {
  console.error('❌ Firestore DB initialization failed.');
}

// Re-export serverTimestamp
export const serverTimestamp = fsServerTimestamp;

export async function getBotConfig() {
  if (!db) return null;
  try {
    const docRef = doc(db, 'config', 'bot');
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() : null;
  } catch (error) {
    console.error('Error getting bot config:', error);
    return null;
  }
}

export async function updateBotConfig(data: any) {
  if (!db) return false;
  try {
    const docRef = doc(db, 'config', 'bot');
    await setDoc(docRef, data, { merge: true });
    return true;
  } catch (error) {
    console.error('Error updating bot config:', error);
    return false;
  }
}

