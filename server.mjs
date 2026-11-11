#!/usr/bin/env node
// MCP server that lets Claude control the Grok Bot desktop app.
//   stdio (Claude Desktop / Claude Code):  node server.mjs
//   HTTP  (for a tunnel → claude.ai web/phone custom connector):  node server.mjs --http 8790
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as grok from './grok.mjs';

const fmt = (msgs) => msgs.length
  ? msgs.map(m => `[${m.kind === 'user' ? 'You' : m.kind === 'event' ? 'Event' : 'Grok'}${m.time ? ' ' + m.time : ''}] ${m.text}`).join('\n\n')
  : '(no messages)';
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

function buildServer() {
  const server = new McpServer({ name: 'grok-bot-bridge', version: '1.0.0' });

  server.registerTool('grok_send', {
    title: 'Message Grok Bot',
    description: 'Send a message to a bot in the Grok Bot desktop app and wait for its reply. ' +
      'Grok Bot is an agent that can browse the web, make phone calls, send email, and run routines, so it may act on the message. ' +
      'If it is still working when the wait ends, call grok_read later to get the rest.',
    inputSchema: {
      message: z.string().min(1).describe('What to say to the bot'),
      bot: z.string().optional().describe('Bot name or id (default: the bot currently open)'),
      wait_seconds: z.number().int().min(0).max(600).optional().describe('How long to wait for the reply (default 120, 0 = do not wait)'),
    },
  }, async ({ message, bot, wait_seconds }) => {
    try {
      const r = await grok.exclusive(() => grok.sendMessage(message, { bot, waitSeconds: wait_seconds ?? 120 }));
      const replies = r.messages.filter(m => m.kind !== 'user');
      const head = r.done ? `${r.bot} replied:` : `Sent to ${r.bot}. ${replies.length ? 'Still working; so far:' : 'Still working (no reply yet). Use grok_read to check back.'}`;
      return text(`${head}\n\n${replies.length ? fmt(replies) : ''}`.trim());
    } catch (e) { return fail(e); }
  });

  server.registerTool('grok_read', {
    title: 'Read Grok Bot chat',
    description: 'Read the latest messages in a Grok Bot chat (also shows whether the bot is still working).',
    inputSchema: {
      count: z.number().int().min(1).max(50).optional().describe('How many recent messages (default 10)'),
      bot: z.string().optional().describe('Bot name or id (default: the bot currently open)'),
      wait_until_idle_seconds: z.number().int().min(0).max(600).optional().describe('If the bot is working, wait up to this long for it to finish first'),
    },
  }, async ({ count, bot, wait_until_idle_seconds }) => {
    try {
      const r = await grok.exclusive(async () => {
        if (bot) await grok.selectBot(bot);
        if (wait_until_idle_seconds) {
          const end = Date.now() + wait_until_idle_seconds * 1000;
          while (Date.now() < end && (await grok.status()).working) await new Promise(r => setTimeout(r, 1000));
        }
        return grok.readMessages(count ?? 10);
      });
      return text(`Bot: ${r.bot} — ${r.working ? 'WORKING' : 'idle'}\n\n${fmt(r.messages)}`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('grok_list_bots', {
    title: 'List Grok bots',
    description: 'List the bots in the Grok Bot app and which one is open.',
    inputSchema: {},
  }, async () => {
    try {
      const s = await grok.exclusive(() => grok.status());
      return text(`Status: ${s.working ? 'WORKING' : 'idle'}${s.live ? ` (${s.live})` : ''}\n` +
        s.bots.map(b => `- ${b.name}${b.main ? ' (main)' : ''}${b.active ? ' [open]' : ''} — id ${b.id}`).join('\n'));
    } catch (e) { return fail(e); }
  });

  server.registerTool('grok_select_bot', {
    title: 'Open a Grok bot',
    description: 'Switch the Grok Bot app to a different bot.',
    inputSchema: { bot: z.string().describe('Bot name (or part of it) or id') },
  }, async ({ bot }) => {
    try { return text(`Opened ${await grok.exclusive(() => grok.selectBot(bot))}.`); }
    catch (e) { return fail(e); }
  });

  return server;
}

// ---------- transports ----------

const httpIdx = process.argv.indexOf('--http');
if (httpIdx === -1) {
  await buildServer().connect(new StdioServerTransport());
} else {
  const port = Number(process.argv[httpIdx + 1] || 8790);
  // Secret path token: anyone with the URL can drive your bot, so it must be unguessable.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const tokenFile = path.join(dir, '.bridge-token');
  const token = process.env.GROK_BRIDGE_TOKEN ||
    (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim()
      : (() => { const t = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(tokenFile, t); return t; })());
  const route = `/mcp/${token}`;

  http.createServer(async (req, res) => {
    if (req.url.split('?')[0] !== route) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const c of req) body += c;
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null }));
    }
  }).listen(port, '127.0.0.1', () => {
    console.error(`Grok bridge listening on http://127.0.0.1:${port}${route}`);
  });
}
