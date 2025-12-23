import dns from 'dns';
import https from 'https';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cloudscraper from 'cloudscraper';
import { retryWithBackoff } from './utils/retryLogic.js';

// ======== IPv4-Only Configuration ========
dns.setDefaultResultOrder('ipv4first');

// Load environment variables
dotenv.config();

// ======== Keep-Alive HTTPS Agent ========
const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000, // 30 second timeout
  keepAliveMsecs: 30000,
});

// ======== Telegram Bot Initialization ========
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in environment');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    apiRoot: 'https://api.telegram.org',
    agent: httpsAgent,
  },
  polling: {
    timeout: 30, // 30 second polling timeout
    limit: 100,
    allowedUpdates: ['message', 'callback_query'],
  },
});

// ======== Wallet Initialization ========
let userWallet = null;
const privateKey = process.env.ETHEREUM_PRIVATE_KEY;

function initializeWallet() {
  if (!privateKey) {
    console.warn('⚠️  No ETHEREUM_PRIVATE_KEY found in environment');
    return null;
  }
  try {
    userWallet = new ethers.Wallet(privateKey);
    console.log('✅ Wallet initialized:', userWallet.address);
    return userWallet;
  } catch (error) {
    console.error('❌ Failed to initialize wallet:', error.message);
    return null;
  }
}

// ======== PactSwap Configuration ========
const API_BASE_URL = process.env.PACTSWAP_API_URL || 'https://hub.pactswap.io/api';
const WEBSITE_ID = process.env.PACTSWAP_WEBSITE_ID || 'c3b59f60-7af2-4ed0-b7bd-a516d529164f';
const ORGANIZATION_ID = process.env.PACTSWAP_ORGANIZATION_ID || 'c3a57acb-4b05-4162-809f-a1f8729cdf9a';
const LOYALTY_RULE_ID = process.env.PACTSWAP_LOYALTY_RULE_ID || '6a796160-bb9e-45f8-85a6-90747d44423e';
const SESSION_TOKEN = process.env.PACTSWAP_SESSION_TOKEN || null;
const PACTSWAP_USER_ID = process.env.PACTSWAP_USER_ID || null;

// Axios client with Cloudflare-friendly headers
const API_CLIENT = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  httpsAgent,
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://hub.pactswap.io',
    'Referer': 'https://hub.pactswap.io/loyalty',
    'Cache-Control': 'no-cache',
  },
});

// Wrapper for Cloudflare-protected requests using cloudscraper
async function makeProtectedRequest(method, url, data = null) {
  return retryWithBackoff(async () => {
    try {
      const options = { 
        method: method.toUpperCase(),
        url,
      };
      if (data) {
        options.json = data;
      }
      const response = await cloudscraper(options);
      return response;
    } catch (error) {
      console.warn(`⚠️  Cloudflare bypass attempt failed: ${error.message}`);
      throw error;
    }
  }, 1); // Single attempt for cloudscraper
}

// ======== User Session Storage (In Memory - use DB for production) ========
let userSessions = {}; // Map: telegramUserId -> {pactswapUserId, walletAddress, sessionToken, expires}
let globalAuthToken = null;
let tokenRefreshInterval = null;

async function refreshAuthToken() {
  if (!userWallet || !PACTSWAP_USER_ID) {
    return null;
  }

  try {
    // Generate new token using wallet signature
    globalAuthToken = {
      user: {
        id: PACTSWAP_USER_ID,
        walletAddress: userWallet.address,
      },
      sessionToken: null, // Wallet-based auth
      generatedAt: Date.now(),
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    };

    console.log(`✅ Auth token refreshed for wallet ${userWallet.address.substring(0, 10)}...`);
    return globalAuthToken;
  } catch (error) {
    console.error(`❌ Token refresh failed:`, error.message);
    console.warn(`⚠️ Check: ETHEREUM_PRIVATE_KEY is valid (${privateKey ? 'SET' : 'NOT SET'})`);
    return null;
  }
}

async function getAuthSession() {
  // Check if global token needs refresh (every 6 days)
  if (globalAuthToken) {
    const expiresIn = new Date(globalAuthToken.expires).getTime() - Date.now();
    if (expiresIn > 0 && expiresIn < 24 * 60 * 60 * 1000) { // Less than 1 day left
      console.log('🔄 Token expiring soon - refreshing...');
      await refreshAuthToken();
    } else if (expiresIn <= 0) {
      console.log('🔄 Token expired - refreshing...');
      await refreshAuthToken();
    }
  }

  // Use existing token or create new one
  if (globalAuthToken) {
    return globalAuthToken;
  }

  // Wallet-based authentication - use Ethereum wallet + user ID
  if (userWallet && PACTSWAP_USER_ID) {
    return await refreshAuthToken();
  }

  // Fallback: Try API session if available
  if (SESSION_TOKEN && PACTSWAP_USER_ID) {
    return {
      user: {
        id: PACTSWAP_USER_ID,
        walletAddress: userWallet?.address || 'No wallet configured',
      },
      sessionToken: SESSION_TOKEN,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  return null;
}

async function initializeUserSession(telegramUserId) {
  try {
    const sessionData = await getAuthSession();
    
    if (sessionData && sessionData.user) {
      userSessions[telegramUserId] = {
        pactswapUserId: sessionData.user.id,
        walletAddress: sessionData.user.walletAddress,
        sessionToken: sessionData.sessionToken,
        expires: sessionData.expires,
      };
      
      console.log(`✅ Telegram user ${telegramUserId} authenticated:`, {
        pactswapUserId: sessionData.user.id.substring(0, 8),
        wallet: sessionData.user.walletAddress.substring(0, 10) + '...',
      });
      
      return userSessions[telegramUserId];
    } else {
      console.warn(`⚠️ Authentication failed for user ${telegramUserId}`);
      console.warn('   Required: PACTSWAP_USER_ID environment variable');
      console.warn(`   Using: Ethereum wallet (${userWallet?.address || 'Not initialized'})`);
      return null;
    }
  } catch (error) {
    console.error('❌ Session initialization failed:', error.message);
    return null;
  }
}

function getUserSession(telegramUserId) {
  return userSessions[telegramUserId] || null;
}

async function fetchUserProfile(userId) {
  return retryWithBackoff(async () => {
    try {
      // Try Cloudflare-protected request first
      const response = await makeProtectedRequest('GET', `${API_BASE_URL}/user/${userId}`);
      return response.data || response;
    } catch (cfError) {
      // Fall back to regular axios request
      try {
        const response = await API_CLIENT.get(`/user/${userId}`);
        return response.data;
      } catch (axiosError) {
        console.error(`❌ All fetch profile attempts failed`);
        throw axiosError;
      }
    }
  }, 3);
}

async function submitCheckIn(userId, checkInData) {
  return retryWithBackoff(async () => {
    try {
      // Submit check-in to PactSwap API
      // Endpoint: POST /api/loyalty/rules/{loyaltyRuleId}/complete
      // Body: {} (empty JSON)
      const checkInUrl = `${API_BASE_URL}/loyalty/rules/${LOYALTY_RULE_ID}/complete`;
      
      console.log(`📤 Submitting check-in for user ${userId} to ${checkInUrl}`);
      
      const response = await API_CLIENT.post(checkInUrl, {});
      
      return {
        success: true,
        message: response.data?.message || 'Check-in submitted',
        points: checkInData.points || 10,
        totalPoints: checkInData.totalPoints || 0,
        streak: checkInData.streak || 1,
      };
    } catch (axiosError) {
      console.error(`❌ Check-in submission failed:`, axiosError.response?.status, axiosError.message);
      throw axiosError;
    }
  }, 3);
}

async function getCheckInStatus(userId, walletAddress) {
  return retryWithBackoff(async () => {
    try {
      // Get check-in status from PactSwap API
      // Endpoint: GET /api/loyalty/rules/status?websiteId=...&organizationId=...&userId=...
      const statusUrl = `${API_BASE_URL}/loyalty/rules/status`;
      
      const response = await API_CLIENT.get(statusUrl, {
        params: {
          websiteId: WEBSITE_ID,
          organizationId: ORGANIZATION_ID,
          userId: userId,
        },
      });
      
      return response.data?.data || [];
    } catch (axiosError) {
      console.error(`❌ Failed to fetch check-in status:`, axiosError.message);
      return [];
    }
  }, 3);
}

async function getLoyaltyCurrencies() {
  return retryWithBackoff(async () => {
    try {
      // Get loyalty currencies from PactSwap API
      // Endpoint: GET /api/loyalty/currencies
      const currenciesUrl = `${API_BASE_URL}/loyalty/currencies`;
      
      const response = await API_CLIENT.get(currenciesUrl, {
        params: {
          limit: 10,
          websiteId: WEBSITE_ID,
          organizationId: ORGANIZATION_ID,
        },
      });
      
      return response.data?.data || [];
    } catch (axiosError) {
      console.error(`❌ Failed to fetch loyalty currencies:`, axiosError.message);
      return [];
    }
  }, 3);
}

async function getTransactionEntries(userId, walletAddress) {
  return retryWithBackoff(async () => {
    try {
      // Get transaction entries to calculate loyalty points balance
      // Endpoint: GET /api/loyalty/transaction_entries
      const transactionUrl = `${API_BASE_URL}/loyalty/transaction_entries`;
      
      const response = await API_CLIENT.get(transactionUrl, {
        params: {
          limit: 100,
          orderBy: 'createdAt',
          websiteId: WEBSITE_ID,
          userId: userId,
          organizationId: ORGANIZATION_ID,
          includeLastCompleted: true,
          hideFailedMints: true,
        },
      });
      
      return response.data?.data || [];
    } catch (axiosError) {
      console.error(`❌ Failed to fetch transaction entries:`, axiosError.message);
      return [];
    }
  }, 3);
}

async function getLoyaltyRuleGroups() {
  return retryWithBackoff(async () => {
    try {
      // Get loyalty rule groups (quests) from PactSwap API
      // Endpoint: GET /api/loyalty/rule_groups
      const ruleGroupsUrl = `${API_BASE_URL}/loyalty/rule_groups`;
      
      const response = await API_CLIENT.get(ruleGroupsUrl, {
        params: {
          limit: 10,
          websiteId: WEBSITE_ID,
          organizationId: ORGANIZATION_ID,
          isActive: true,
        },
      });
      
      return response.data?.data || [];
    } catch (axiosError) {
      console.error(`❌ Failed to fetch loyalty rule groups:`, axiosError.message);
      return [];
    }
  }, 3);
}

async function getSpecialLoyaltyRules() {
  return retryWithBackoff(async () => {
    try {
      // Get special/exclusive loyalty rules from PactSwap API
      // Endpoint: GET /api/loyalty/rules?isSpecial=true
      const specialRulesUrl = `${API_BASE_URL}/loyalty/rules`;
      
      const response = await API_CLIENT.get(specialRulesUrl, {
        params: {
          limit: 10,
          websiteId: WEBSITE_ID,
          organizationId: ORGANIZATION_ID,
          isSpecial: true,
        },
      });
      
      return response.data?.data || [];
    } catch (axiosError) {
      console.error(`❌ Failed to fetch special loyalty rules:`, axiosError.message);
      return [];
    }
  }, 3);
}

// ======== Telegram Command Handlers ========

// /start - Main Menu (Only Command)
bot.command('start', async (ctx) => {
  const telegramUserId = ctx.from.id;
  const userName = ctx.from.first_name || 'User';

  console.log(`👤 New user started: ${userName} (${telegramUserId})`);

  try {
    // Initialize wallet if not done
    if (!userWallet) {
      initializeWallet();
    }

    // Initialize or get user session with PactSwap
    let session = getUserSession(telegramUserId);
    if (!session) {
      session = await initializeUserSession(telegramUserId);
    }

    if (!session) {
      return ctx.reply('❌ Tidak dapat terhubung ke PactSwap. Silakan coba lagi.');
    }

    ctx.reply(
      `🎉 Selamat datang, ${userName}!\n\n` +
      '🤖 Bot Check-In Minggu Anda siap digunakan.\n\n' +
      '💡 Pilih menu di bawah untuk memulai:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Check-In Harian', callback_data: 'menu_checkin' }],
            [{ text: '👤 Profil Saya', callback_data: 'menu_profile' }],
            [{ text: '🎯 Quests', callback_data: 'menu_quests' }],
            [{ text: '⭐ Exclusive Access', callback_data: 'menu_exclusive' }],
            [{ text: '📊 Status Check-In', callback_data: 'menu_status' }],
            [{ text: '❓ Bantuan', callback_data: 'menu_help' }],
          ],
        },
      }
    );
  } catch (error) {
    console.error('Error in /start:', error);
    ctx.reply('❌ Terjadi kesalahan. Silakan coba lagi.');
  }
});

// ======== Callback Query Handlers (Menu Navigation) ========

// Check-In Menu
bot.action('menu_checkin', async (ctx) => {
  const telegramUserId = ctx.from.id;
  console.log(`📍 Check-in requested by user ${telegramUserId}`);

  try {
    await ctx.answerCbQuery('⏳ Memproses...');
    
    // Get user session
    let session = getUserSession(telegramUserId);
    if (!session) {
      session = await initializeUserSession(telegramUserId);
    }

    if (!session) {
      return await ctx.editMessageText(
        '❌ Sesi tidak valid. Silakan lakukan /start terlebih dahulu.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
            ],
          },
        }
      );
    }

    const checkInData = {
      type: 'weekly',
      deviceInfo: 'telegram_bot',
      pactswapUserId: session.pactswapUserId,
    };

    const result = await submitCheckIn(session.pactswapUserId, checkInData);
    const currencies = await getLoyaltyCurrencies();
    const currencySymbol = currencies.length > 0 ? currencies[0].symbol : 'POINTS';

    await ctx.editMessageText(
      `✅ Check-in Minggu Ini Berhasil!\n\n` +
      `🎁 Status: ${result.message || 'Diproses'}\n` +
      `💰 Reward: ${currencySymbol}\n` +
      `💼 Wallet: ${session.walletAddress.substring(0, 10)}...\n\n` +
      `🔥 Jangan lupa check-in lagi minggu depan!\n` +
      `⏱️ Reset setiap Minggu`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    console.error('Error in menu_checkin:', error.message);
    await ctx.editMessageText(
      `❌ Gagal melakukan check-in.\n\n` +
      `Kemungkinan:\n` +
      `• Sudah check-in minggu ini\n` +
      `• Masalah koneksi API\n\n` +
      `Silakan coba lagi dalam beberapa saat.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  }
});

// Profile Menu
bot.action('menu_profile', async (ctx) => {
  const telegramUserId = ctx.from.id;
  console.log(`👤 Profile requested by user ${telegramUserId}`);

  try {
    await ctx.answerCbQuery('⏳ Mengambil profil...');

    // Get user session
    let session = getUserSession(telegramUserId);
    if (!session) {
      session = await initializeUserSession(telegramUserId);
    }

    if (!session) {
      return await ctx.editMessageText(
        '❌ Sesi tidak valid. Silakan lakukan /start terlebih dahulu.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
            ],
          },
        }
      );
    }

    // Get transaction entries to calculate point balance
    const transactions = await getTransactionEntries(session.pactswapUserId, session.walletAddress);
    const currencies = await getLoyaltyCurrencies();
    
    // Calculate total points from transactions
    let totalPoints = 0;
    if (transactions.length > 0) {
      transactions.forEach(tx => {
        if (tx.direction === 'credit') {
          totalPoints += parseInt(tx.amount || 0);
        } else if (tx.direction === 'debit') {
          totalPoints -= parseInt(tx.amount || 0);
        }
      });
    }

    const currencySymbol = currencies.length > 0 ? currencies[0].symbol : 'POINTS';

    await ctx.editMessageText(
      `👤 Profil Anda\n\n` +
      `📛 Nama: ${ctx.from.first_name} ${ctx.from.last_name || ''}\n` +
      `🆔 Telegram: ${telegramUserId}\n` +
      `🎯 PactSwap: ${session.pactswapUserId.substring(0, 8)}...\n` +
      `💼 Wallet: ${session.walletAddress.substring(0, 10)}...\n\n` +
      `💰 Total ${currencySymbol}: ${totalPoints}\n` +
      `📊 Transaksi: ${transactions.length} kali\n` +
      `🏆 Status: Aktif`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'menu_profile' }],
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    console.error('Error in menu_profile:', error.message);
    await ctx.editMessageText(
      '❌ Gagal memuat profil. Silakan coba lagi.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  }
});

// Quests Menu
bot.action('menu_quests', async (ctx) => {
  const telegramUserId = ctx.from.id;
  console.log(`🎯 Quests requested by user ${telegramUserId}`);

  try {
    await ctx.answerCbQuery('🎯 Memuat quests...');

    // Get user session
    let session = getUserSession(telegramUserId);
    if (!session) {
      session = await initializeUserSession(telegramUserId);
    }

    if (!session) {
      return await ctx.editMessageText(
        '❌ Sesi tidak valid. Silakan lakukan /start terlebih dahulu.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
            ],
          },
        }
      );
    }

    // Get loyalty rule groups (quests)
    const ruleGroups = await getLoyaltyRuleGroups();
    
    let questsText = '';
    if (ruleGroups.length > 0) {
      ruleGroups.forEach(group => {
        questsText += `\n📋 ${group.name}:\n`;
        if (group.loyaltyGroupItems && group.loyaltyGroupItems.length > 0) {
          group.loyaltyGroupItems.forEach(item => {
            const rule = item.loyaltyRule;
            questsText += `  🎁 ${rule.name} - +${rule.amount} PACT\n`;
          });
        }
      });
    } else {
      questsText = 'Tidak ada quests yang tersedia saat ini';
    }

    await ctx.editMessageText(
      `🎯 Available Quests\n\n${questsText}\n\n💡 Selesaikan quests untuk mendapatkan Pact Points!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'menu_quests' }],
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    console.error('Error in menu_quests:', error.message);
    await ctx.editMessageText(
      '❌ Gagal memuat quests. Silakan coba lagi.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  }
});

// Exclusive Access Menu
bot.action('menu_exclusive', async (ctx) => {
  const telegramUserId = ctx.from.id;
  console.log(`⭐ Exclusive Access requested by user ${telegramUserId}`);

  try {
    await ctx.answerCbQuery('⭐ Memuat exclusive access...');

    // Get user session
    let session = getUserSession(telegramUserId);
    if (!session) {
      session = await initializeUserSession(telegramUserId);
    }

    if (!session) {
      return await ctx.editMessageText(
        '❌ Sesi tidak valid. Silakan lakukan /start terlebih dahulu.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
            ],
          },
        }
      );
    }

    // Get special loyalty rules
    const specialRules = await getSpecialLoyaltyRules();
    
    let exclusiveText = '';
    if (specialRules.length > 0) {
      specialRules.forEach((rule, index) => {
        exclusiveText += `\n⭐ ${rule.name}:\n`;
        if (rule.description) {
          exclusiveText += `   ${rule.description}\n`;
        }
        exclusiveText += `   💰 Reward: +${rule.amount} PACT\n`;
      });
    } else {
      exclusiveText = 'Tidak ada exclusive access yang tersedia saat ini';
    }

    await ctx.editMessageText(
      `⭐ Exclusive Access\n\n${exclusiveText}\n\n✨ Bonus akses eksklusif tersedia untuk member spesial!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'menu_exclusive' }],
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    console.error('Error in menu_exclusive:', error.message);
    await ctx.editMessageText(
      '❌ Gagal memuat exclusive access. Silakan coba lagi.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  }
});

// Status Menu
bot.action('menu_status', async (ctx) => {
  const telegramUserId = ctx.from.id;
  console.log(`📊 Status requested by user ${telegramUserId}`);

  try {
    await ctx.answerCbQuery('📊 Mengambil status...');

    // Get user session
    let session = getUserSession(telegramUserId);
    if (!session) {
      session = await initializeUserSession(telegramUserId);
    }

    if (!session) {
      return await ctx.editMessageText(
        '❌ Sesi tidak valid. Silakan lakukan /start terlebih dahulu.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
            ],
          },
        }
      );
    }

    // Get real check-in status from PactSwap API
    const statusList = await getCheckInStatus(session.pactswapUserId, session.walletAddress);
    
    const statusText = statusList.length > 0
      ? statusList.map(s => `📍 Status: ${s.status}`).join('\n')
      : '📍 Belum ada data check-in';

    await ctx.editMessageText(
      `📊 Status Check-In Anda\n\n` +
      `👤 Telegram: ${telegramUserId}\n` +
      `💼 Wallet: ${session.walletAddress.substring(0, 10)}...\n\n` +
      `${statusText}\n\n` +
      `💡 Jangan lupa check-in setiap minggu!`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'menu_status' }],
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  } catch (error) {
    console.error('Error in menu_status:', error.message);
    await ctx.editMessageText(
      '❌ Gagal memuat status. Silakan coba lagi.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
          ],
        },
      }
    );
  }
});

// Help Menu
bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery('❓ Bantuan');

  await ctx.editMessageText(
    `❓ Bantuan\n\n` +
    `📋 Fitur Bot:\n` +
    `✅ Check-In - Lakukan check-in harian untuk poin\n` +
    `👤 Profil - Lihat profil dan statistik Anda\n` +
    `📊 Status - Cek status check-in terbaru\n\n` +
    `🎯 Cara Kerja:\n` +
    `1. Klik tombol "Check-In Harian"\n` +
    `2. Check-in setiap hari untuk poin rewards\n` +
    `3. Kumpulkan poin dan naik level\n` +
    `4. Dapatkan reward eksklusif!\n\n` +
    `🎁 Bonus:\n` +
    `Streak 7 hari = 100 poin ekstra\n` +
    `Streak 30 hari = Gold Badge\n\n` +
    `💬 Pertanyaan? Hubungi support.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }],
        ],
      },
    }
  );
});

// Back to Menu
bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery('Menu');

  await ctx.editMessageText(
    `🎉 Menu Utama\n\n💡 Pilih menu di bawah untuk memulai:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Check-In Harian', callback_data: 'menu_checkin' }],
          [{ text: '👤 Profil Saya', callback_data: 'menu_profile' }],
          [{ text: '🎯 Quests', callback_data: 'menu_quests' }],
          [{ text: '⭐ Exclusive Access', callback_data: 'menu_exclusive' }],
          [{ text: '📊 Status Check-In', callback_data: 'menu_status' }],
          [{ text: '❓ Bantuan', callback_data: 'menu_help' }],
        ],
      },
    }
  );
});

// ======== Error Handling ========
bot.catch((err, ctx) => {
  console.error('❌ Bot Error:', {
    error: err.message,
    userId: ctx.from?.id,
    command: ctx.message?.text,
  });
  ctx.reply('❌ Terjadi kesalahan. Silakan coba lagi.');
});

// ======== Graceful Shutdown ========
process.on('SIGINT', async () => {
  console.log('\n🛑 Menghentikan bot...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Menghentikan bot (SIGTERM)...');
  await bot.stop();
  process.exit(0);
});

// ======== Bot Startup ========
async function startBot() {
  try {
    initializeWallet();
    console.log('🚀 Starting Telegram Check-In Bot...');
    console.log(`📱 Bot Token: ${BOT_TOKEN.substring(0, 10)}...`);
    console.log(`🔗 API Base: ${API_BASE_URL}`);
    console.log('🌐 IPv4-Only Mode: ENABLED');
    console.log('🔗 Keep-Alive: ENABLED (30s timeout)');
    console.log('⚡ Retry Logic: 3x attempts with exponential backoff');
    console.log('🛡️  Cloudflare Protection Bypass: ENABLED');

    // Verify wallet
    if (!userWallet) {
      console.error('❌ Wallet not initialized!');
      console.error('   Check: ETHEREUM_PRIVATE_KEY environment variable');
      process.exit(1);
    }

    // Initialize and setup auto-refresh for auth token
    if (PACTSWAP_USER_ID) {
      await refreshAuthToken();
      
      // Auto-refresh token every 6 days
      tokenRefreshInterval = setInterval(async () => {
        console.log('⏰ Scheduled token refresh...');
        await refreshAuthToken();
      }, 6 * 24 * 60 * 60 * 1000); // 6 days

      console.log('✅ Auto-refresh enabled (every 6 days)');
    } else {
      console.warn('⚠️ PACTSWAP_USER_ID not set - auth disabled');
      console.warn('   Set PACTSWAP_USER_ID in environment to enable full functionality');
    }

    await bot.launch();
    console.log('✅ Bot is running and listening for commands...');

    // Graceful shutdown with token cleanup
    process.once('SIGINT', () => {
      if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
      bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      if (tokenRefreshInterval) clearInterval(tokenRefreshInterval);
      bot.stop('SIGTERM');
    });
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    process.exit(1);
  }
}

startBot();

export { bot, API_CLIENT, userSessions };
