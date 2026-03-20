/**
 * Firebase Cloud Functions for Table Tennis Club Attendance App
 *
 * Functions:
 * 1. onRegistrationUpdate - Triggers when a registration status changes to 'pending_upgrade'
 *    → Sends LINE/email notification to the upgraded user
 * 2. onCancelRegistration (HTTP) - Called from client to cancel a registration
 * 3. sendDailyReminder - Scheduled function to send day-before reminders
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { defineString, defineSecret } = require('firebase-functions/params');
const nodemailer = require('nodemailer');
const line = require('@line/bot-sdk');

initializeApp();
const db = getFirestore();

// ── Config params (set in Firebase console or .env)
const APP_URL = defineString('APP_URL', { default: 'https://your-app.web.app' });
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const SMTP_HOST = defineString('SMTP_HOST', { default: 'smtp.gmail.com' });
const SMTP_PORT = defineString('SMTP_PORT', { default: '587' });
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const EMAIL_FROM = defineString('EMAIL_FROM', { default: '卓球クラブ <noreply@example.com>' });
const CLUB_NAME = defineString('CLUB_NAME', { default: '卓球クラブ' });

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const date = new Date(`${dateStr}T00:00:00+09:00`);
  return `${parseInt(m)}月${parseInt(d)}日(${days[date.getDay()]})`;
}

async function getSession(sessionId) {
  const snap = await db.collection('sessions').doc(sessionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function sendLineNotification(lineUserId, message, token, lineClient) {
  if (!lineUserId || !lineClient) return false;
  try {
    const appUrl = APP_URL.value();
    const upgradeUrl = `${appUrl}/?upgrade=${token}`;
    await lineClient.pushMessage(lineUserId, {
      type: 'template',
      altText: message,
      template: {
        type: 'confirm',
        text: message,
        actions: [
          { type: 'uri', label: '参加する', uri: upgradeUrl + '&accept=1' },
          { type: 'uri', label: '参加しない', uri: upgradeUrl + '&accept=0' },
        ],
      },
    });
    return true;
  } catch (err) {
    console.error('LINE notification error:', err);
    return false;
  }
}

async function sendEmailNotification(email, subject, html, smtpUser, smtpPass) {
  if (!email) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port: parseInt(SMTP_PORT.value()),
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
    });
    await transporter.sendMail({
      from: EMAIL_FROM.value(),
      to: email,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error('Email notification error:', err);
    return false;
  }
}

// ── Function 1: Watch for pending_upgrade status ───────────────────────────────

exports.onRegistrationUpgrade = onDocumentUpdated(
  {
    document: 'registrations/{registrationId}',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SMTP_USER, SMTP_PASS],
    region: 'asia-northeast1',
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // Only trigger when status changes to 'pending_upgrade'
    if (before.status === after.status || after.status !== 'pending_upgrade') return;

    const reg = { id: event.params.registrationId, ...after };
    const session = await getSession(reg.sessionId);
    if (!session) return;

    const dateStr = formatDate(session.date);
    const clubName = CLUB_NAME.value();
    const appUrl = APP_URL.value();
    const upgradeUrl = `${appUrl}/?upgrade=${reg.notificationToken}`;
    const message = `【${clubName}】${dateStr}の練習に空きが出ました！参加しますか？`;

    let notified = false;

    // Try LINE first
    if (reg.lineUserId && LINE_CHANNEL_ACCESS_TOKEN.value()) {
      const lineClient = new line.messagingApi.MessagingApiClient({
        channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value(),
      });
      notified = await sendLineNotification(reg.lineUserId, message, reg.notificationToken, lineClient);
    }

    // Fallback to email
    if (!notified && reg.email) {
      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#1d4ed8">🏓 ${clubName}</h2>
          <h3>練習参加のご案内</h3>
          <p>${reg.childName} さんの保護者様</p>
          <p>
            <strong>${dateStr}</strong>の練習にキャンセルが発生し、空きが出ました。<br>
            参加しますか？
          </p>
          <div style="margin:24px 0;display:flex;gap:12px">
            <a href="${upgradeUrl}?accept=1"
               style="display:inline-block;background:#2563eb;color:white;padding:14px 28px;
                      border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">
              ✅ 参加する
            </a>
            <a href="${upgradeUrl}?accept=0"
               style="display:inline-block;background:#6b7280;color:white;padding:14px 28px;
                      border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">
              参加しない
            </a>
          </div>
          <p style="color:#6b7280;font-size:12px">
            ※ このリンクは一度のみ有効です。<br>
            ※ 「参加しない」の場合は次のキャンセル待ちの方にご連絡します。
          </p>
        </div>
      `;
      notified = await sendEmailNotification(
        reg.email,
        `【${clubName}】${dateStr}の練習に空きが出ました`,
        html,
        SMTP_USER.value(),
        SMTP_PASS.value()
      );
    }

    // Record notification attempt
    await db.collection('notificationLogs').add({
      registrationId: reg.id,
      sessionId: reg.sessionId,
      type: 'upgrade_offer',
      channel: reg.lineUserId ? 'line' : 'email',
      notified,
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(`Upgrade notification sent: reg=${reg.id}, notified=${notified}`);
  }
);

// ── Function 2: HTTP endpoint for upgrade response ────────────────────────────
// This handles the accept/decline via URL param (for LINE quick replies)

exports.upgradeResponse = onRequest(
  {
    region: 'asia-northeast1',
    cors: true,
  },
  async (req, res) => {
    const { token, accept } = req.query;
    if (!token) {
      res.redirect('/?error=invalid');
      return;
    }

    const appUrl = APP_URL.value();
    // Redirect to the SPA upgrade page for full UI handling
    res.redirect(`${appUrl}/?upgrade=${token}&accept=${accept}`);
  }
);

// ── Function 3: Daily reminder (8am JST) ─────────────────────────────────────

exports.sendDailyReminder = onSchedule(
  {
    schedule: '0 8 * * *',
    timeZone: 'Asia/Tokyo',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SMTP_USER, SMTP_PASS],
    region: 'asia-northeast1',
  },
  async (event) => {
    // Find sessions scheduled for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const sessionsSnap = await db.collection('sessions')
      .where('date', '==', tomorrowStr)
      .get();

    if (sessionsSnap.empty) {
      console.log('No sessions tomorrow');
      return;
    }

    const clubName = CLUB_NAME.value();

    for (const sessionDoc of sessionsSnap.docs) {
      const session = { id: sessionDoc.id, ...sessionDoc.data() };
      const dateStr = formatDate(session.date);

      // Get confirmed registrations
      const regsSnap = await db.collection('registrations')
        .where('sessionId', '==', session.id)
        .where('status', '==', 'confirmed')
        .get();

      for (const regDoc of regsSnap.docs) {
        const reg = regDoc.data();
        const message = `【${clubName}】明日 ${dateStr} の練習のご案内\n${reg.childName}さんの参加が確定しています。お気をつけてお越しください！`;

        // Send LINE
        if (reg.lineUserId && LINE_CHANNEL_ACCESS_TOKEN.value()) {
          const lineClient = new line.messagingApi.MessagingApiClient({
            channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value(),
          });
          try {
            await lineClient.pushMessage(reg.lineUserId, {
              type: 'text',
              text: message,
            });
          } catch (err) {
            console.error('LINE reminder error:', err);
          }
        }

        // Send email
        if (reg.email) {
          const html = `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
              <h2 style="color:#1d4ed8">🏓 ${clubName}</h2>
              <h3>明日の練習のご案内</h3>
              <p>${reg.childName} さんの保護者様</p>
              <p>明日 <strong>${dateStr}</strong> の練習への参加が確定しています。</p>
              <p>お気をつけてお越しください！</p>
            </div>
          `;
          await sendEmailNotification(
            reg.email,
            `【${clubName}】明日 ${dateStr} の練習のご案内`,
            html,
            SMTP_USER.value(),
            SMTP_PASS.value()
          );
        }
      }
    }

    console.log(`Daily reminders sent for ${tomorrowStr}`);
  }
);
