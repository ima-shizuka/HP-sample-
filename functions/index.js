/**
 * Firebase Cloud Functions for Table Tennis Club Attendance App
 *
 * Functions:
 * 1. onRegistrationUpgrade - Triggers when status changes to 'pending_upgrade'
 *    → Sends LINE/email notification to the user
 * 2. expireUpgradeOffers   - Scheduled every hour: auto-decline offers older than 24h
 *    → Moves expired pending_upgrade → cancelled, promotes next waitlisted
 * 3. sendDailyReminder     - Scheduled 8am JST: day-before reminder to confirmed participants
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineString, defineSecret } = require('firebase-functions/params');
const nodemailer = require('nodemailer');

// LINE SDK is optional — only used when LINE credentials are set
let lineModule = null;
try { lineModule = require('@line/bot-sdk'); } catch (_) {}

initializeApp();
const db = getFirestore();

// ── Config params ──────────────────────────────────────────────────────────────
const APP_URL         = defineString('APP_URL', { default: 'https://your-app.web.app' });
const CLUB_NAME       = defineString('CLUB_NAME', { default: '卓球クラブ' });
const SMTP_HOST       = defineString('SMTP_HOST', { default: 'smtp.gmail.com' });
const SMTP_PORT       = defineString('SMTP_PORT', { default: '587' });
const EMAIL_FROM      = defineString('EMAIL_FROM', { default: '卓球クラブ <noreply@example.com>' });
const UPGRADE_HOURS   = defineString('UPGRADE_HOURS', { default: '24' }); // auto-expire after N hours

const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET       = defineSecret('LINE_CHANNEL_SECRET');
const SMTP_USER                 = defineSecret('SMTP_USER');
const SMTP_PASS                 = defineSecret('SMTP_PASS');

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const date = new Date(`${dateStr}T00:00:00+09:00`);
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}月${parseInt(d)}日(${days[date.getDay()]})`;
}

async function getSessionDoc(sessionId) {
  const snap = await db.collection('sessions').doc(sessionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function promoteNextWaitlisted(sessionId, tx) {
  const wq = db.collection('registrations')
    .where('sessionId', '==', sessionId)
    .where('status', '==', 'waitlisted')
    .orderBy('waitlistPosition', 'asc')
    .limit(1);
  const wSnap = await wq.get();
  if (wSnap.empty) return null;
  const next = wSnap.docs[0];
  const data = { id: next.id, ...next.data() };
  if (tx) {
    tx.update(next.ref, { status: 'pending_upgrade', updatedAt: FieldValue.serverTimestamp() });
    tx.update(db.collection('sessions').doc(sessionId), { waitlistCount: FieldValue.increment(-1) });
  } else {
    await next.ref.update({ status: 'pending_upgrade', updatedAt: FieldValue.serverTimestamp() });
    await db.collection('sessions').doc(sessionId).update({ waitlistCount: FieldValue.increment(-1) });
  }
  return data;
}

async function sendLineMsg(lineUserId, message, accessToken) {
  if (!lineUserId || !accessToken || !lineModule) return false;
  try {
    const client = new lineModule.messagingApi.MessagingApiClient({ channelAccessToken: accessToken });
    await client.pushMessage(lineUserId, { type: 'text', text: message });
    return true;
  } catch (err) {
    console.error('LINE push error:', err.message);
    return false;
  }
}

async function sendLineMsgWithConfirm(lineUserId, message, acceptUrl, declineUrl, accessToken) {
  if (!lineUserId || !accessToken || !lineModule) return false;
  try {
    const client = new lineModule.messagingApi.MessagingApiClient({ channelAccessToken: accessToken });
    await client.pushMessage(lineUserId, {
      type: 'template',
      altText: message,
      template: {
        type: 'confirm',
        text: message,
        actions: [
          { type: 'uri', label: '✅ 参加する', uri: acceptUrl },
          { type: 'uri', label: '参加しない', uri: declineUrl },
        ],
      },
    });
    return true;
  } catch (err) {
    console.error('LINE confirm error:', err.message);
    return false;
  }
}

async function sendEmail(to, subject, html, smtpUser, smtpPass) {
  if (!to || !smtpUser || !smtpPass) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST.value(),
      port: parseInt(SMTP_PORT.value()),
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
    });
    await transporter.sendMail({ from: EMAIL_FROM.value(), to, subject, html });
    return true;
  } catch (err) {
    console.error('Email error:', err.message);
    return false;
  }
}

// ── Function 1: Trigger on pending_upgrade ────────────────────────────────────

exports.onRegistrationUpgrade = onDocumentUpdated(
  {
    document: 'registrations/{registrationId}',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SMTP_USER, SMTP_PASS],
    region: 'asia-northeast1',
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status || after.status !== 'pending_upgrade') return;

    const reg     = { id: event.params.registrationId, ...after };
    const session = await getSessionDoc(reg.sessionId);
    if (!session) return;

    const dateStr    = formatDate(session.date);
    const club       = CLUB_NAME.value();
    const appUrl     = APP_URL.value();
    const acceptUrl  = `${appUrl}/?upgrade=${reg.notificationToken}&accept=1`;
    const declineUrl = `${appUrl}/?upgrade=${reg.notificationToken}&accept=0`;
    const message    = `【${club}】${dateStr}の練習に空きが出ました！参加しますか？`;

    const lineToken = LINE_CHANNEL_ACCESS_TOKEN.value();
    let notified = false;

    // Try LINE first
    if (reg.lineUserId && lineToken) {
      notified = await sendLineMsgWithConfirm(reg.lineUserId, message, acceptUrl, declineUrl, lineToken);
    }

    // Fallback: email
    if (!notified && reg.email) {
      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb">
          <div style="background:white;border-radius:16px;padding:24px;border:1px solid #e5e7eb">
            <h2 style="color:#1d4ed8;margin:0 0 4px">🏓 ${club}</h2>
            <h3 style="margin:0 0 16px;color:#111827">練習参加のご案内</h3>
            <p style="color:#374151">${reg.childName} さんの保護者様</p>
            <p style="color:#374151">
              <strong>${dateStr}</strong>の練習にキャンセルが発生し、空きが出ました。<br>参加しますか？
            </p>
            <div style="margin:24px 0;display:flex;gap:12px;flex-wrap:wrap">
              <a href="${acceptUrl}"
                 style="display:inline-block;background:#2563eb;color:white;padding:14px 28px;
                        border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px">
                ✅ 参加する
              </a>
              <a href="${declineUrl}"
                 style="display:inline-block;background:#6b7280;color:white;padding:14px 28px;
                        border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px">
                参加しない
              </a>
            </div>
            <p style="color:#9ca3af;font-size:12px;margin:0">
              ※ このリンクは${UPGRADE_HOURS.value()}時間以内にご回答ください。<br>
              ※ 期限を過ぎると次のキャンセル待ちの方に自動的にご連絡します。
            </p>
          </div>
        </div>`;
      notified = await sendEmail(
        reg.email,
        `【${club}】${dateStr}の練習に空きが出ました`,
        html,
        SMTP_USER.value(),
        SMTP_PASS.value()
      );
    }

    // Store expiry timestamp for the scheduled expiration check
    const expiresAt = Timestamp.fromDate(
      new Date(Date.now() + parseInt(UPGRADE_HOURS.value()) * 60 * 60 * 1000)
    );
    await db.collection('registrations').doc(reg.id).update({
      upgradeOfferedAt: FieldValue.serverTimestamp(),
      upgradeExpiresAt: expiresAt,
    });

    await db.collection('notificationLogs').add({
      registrationId: reg.id,
      sessionId: reg.sessionId,
      type: 'upgrade_offer',
      channel: reg.lineUserId ? 'line' : (reg.email ? 'email' : 'none'),
      notified,
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(`Upgrade notification: reg=${reg.id}, notified=${notified}`);
  }
);

// ── Function 2: Auto-expire upgrade offers ────────────────────────────────────

exports.expireUpgradeOffers = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'Asia/Tokyo',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SMTP_USER, SMTP_PASS],
    region: 'asia-northeast1',
  },
  async () => {
    const now = Timestamp.now();
    const snap = await db.collection('registrations')
      .where('status', '==', 'pending_upgrade')
      .where('upgradeExpiresAt', '<=', now)
      .get();

    if (snap.empty) {
      console.log('No expired upgrade offers');
      return;
    }

    console.log(`Expiring ${snap.docs.length} upgrade offer(s)`);

    for (const regDoc of snap.docs) {
      const reg = { id: regDoc.id, ...regDoc.data() };

      await db.runTransaction(async (tx) => {
        const rRef = db.collection('registrations').doc(reg.id);
        tx.update(rRef, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
        // Promote next waitlisted (non-transactional helper, pass tx)
      });

      // Promote next outside of transaction (simpler, acceptable for this use case)
      await db.collection('registrations').doc(reg.id).update({
        status: 'cancelled',
        updatedAt: FieldValue.serverTimestamp(),
      });

      const next = await promoteNextWaitlisted(reg.sessionId, null);
      if (next) {
        console.log(`Auto-promoted reg ${next.id} after expiry of ${reg.id}`);
      }

      await db.collection('notificationLogs').add({
        registrationId: reg.id,
        sessionId: reg.sessionId,
        type: 'upgrade_expired',
        notified: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  }
);

// ── Function 3: Daily reminder (8am JST) ──────────────────────────────────────

exports.sendDailyReminder = onSchedule(
  {
    schedule: '0 8 * * *',
    timeZone: 'Asia/Tokyo',
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, SMTP_USER, SMTP_PASS],
    region: 'asia-northeast1',
  },
  async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const sessionsSnap = await db.collection('sessions')
      .where('date', '==', tomorrowStr)
      .get();

    if (sessionsSnap.empty) {
      console.log('No sessions tomorrow:', tomorrowStr);
      return;
    }

    const club     = CLUB_NAME.value();
    const lineToken = LINE_CHANNEL_ACCESS_TOKEN.value();

    for (const sessionDoc of sessionsSnap.docs) {
      const session = { id: sessionDoc.id, ...sessionDoc.data() };
      const dateStr = formatDate(session.date);

      const regsSnap = await db.collection('registrations')
        .where('sessionId', '==', session.id)
        .where('status', '==', 'confirmed')
        .get();

      for (const regDoc of regsSnap.docs) {
        const reg     = regDoc.data();
        const msgText = `【${club}】明日 ${dateStr} の練習のご案内\n${reg.childName}さんの参加が確定しています。お気をつけてお越しください！`;

        if (reg.lineUserId && lineToken) {
          await sendLineMsg(reg.lineUserId, msgText, lineToken);
        }

        if (reg.email) {
          const html = `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb">
              <div style="background:white;border-radius:16px;padding:24px;border:1px solid #e5e7eb">
                <h2 style="color:#1d4ed8;margin:0 0 4px">🏓 ${club}</h2>
                <h3 style="margin:0 0 16px;color:#111827">明日の練習のご案内</h3>
                <p style="color:#374151">${reg.childName} さんの保護者様</p>
                <p style="color:#374151">
                  明日 <strong>${dateStr}</strong> の練習への参加が確定しています。<br>
                  お気をつけてお越しください！
                </p>
                <p style="color:#6b7280;font-size:14px">参加人数：${session.confirmedCount} / ${session.capacity} 人</p>
              </div>
            </div>`;
          await sendEmail(
            reg.email,
            `【${club}】明日 ${dateStr} の練習のご案内`,
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
