/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export default function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6 font-sans">
      <div className="max-w-md w-full bg-zinc-900 rounded-3xl p-8 border border-zinc-800 shadow-2xl">
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 bg-orange-500 rounded-2xl flex items-center justify-center shadow-lg shadow-orange-500/20">
            <span className="text-4xl">🤖</span>
          </div>
        </div>
        
        <h1 className="text-3xl font-semibold text-center mb-2 tracking-tight">Chipotle Bot</h1>
        <p className="text-zinc-400 text-center mb-8">Your Discord companion for ordering.</p>
        
        <div className="bg-zinc-950 rounded-2xl p-6 border border-zinc-800">
          <p className="text-zinc-300 text-sm leading-relaxed">
            The bot is currently active and listening for commands on Discord. 
            Use <code className="bg-zinc-800 text-orange-400 px-2 py-0.5 rounded font-mono text-xs">/order</code> in your server to start.
          </p>
        </div>

        <div className="mt-8 flex items-center justify-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-emerald-500 font-medium text-xs uppercase tracking-wider">System Online</span>
          </div>
        </div>
      </div>
    </div>
  );
}
