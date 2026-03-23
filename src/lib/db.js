/**
 * Firestore data model:
 *
 * /sessions/{sessionId}
 *   date: string (YYYY-MM-DD)
 *   capacity: number
 *   confirmedCount: number
 *   waitlistCount: number
 *   createdAt: Timestamp
 *
 * /registrations/{registrationId}
 *   sessionId: string
 *   parentName: string
 *   childName: string
 *   lineUserId: string | null
 *   email: string | null
 *   status: 'confirmed' | 'waitlisted' | 'cancelled'
 *   waitlistPosition: number | null
 *   notificationToken: string | null  (unique token for upgrade response links)
 *   createdAt: Timestamp
 *   updatedAt: Timestamp
 *
 * /notifications/{notificationId}
 *   registrationId: string
 *   sessionId: string
 *   type: 'upgrade_offer' | 'reminder'
 *   status: 'pending' | 'accepted' | 'declined' | 'expired'
 *   expiresAt: Timestamp
 *   createdAt: Timestamp
 */

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  increment,
  Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';

// ─── Sessions ────────────────────────────────────────────────────────────────

export const sessionsRef = () => collection(db, 'sessions');
export const sessionRef = (id) => doc(db, 'sessions', id);

export async function getSessions() {
  const q = query(sessionsRef(), orderBy('date', 'asc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getSession(id) {
  const snap = await getDoc(sessionRef(id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createSession({ date, startTime, endTime, capacity }) {
  return addDoc(sessionsRef(), {
    date,
    startTime: startTime || null,
    endTime: endTime || null,
    capacity,
    confirmedCount: 0,
    waitlistCount: 0,
    createdAt: serverTimestamp(),
  });
}

export async function updateSession(id, data) {
  return updateDoc(sessionRef(id), { ...data, updatedAt: serverTimestamp() });
}

export async function deleteSession(id) {
  return deleteDoc(sessionRef(id));
}

export function subscribeToSessions(callback) {
  const q = query(sessionsRef(), orderBy('date', 'asc'));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// ─── Registrations ───────────────────────────────────────────────────────────

export const registrationsRef = () => collection(db, 'registrations');
export const registrationRef = (id) => doc(db, 'registrations', id);

export async function getRegistrationsBySession(sessionId) {
  const q = query(
    registrationsRef(),
    where('sessionId', '==', sessionId),
    orderBy('createdAt', 'asc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function subscribeToRegistrations(sessionId, callback) {
  const q = query(
    registrationsRef(),
    where('sessionId', '==', sessionId),
    orderBy('createdAt', 'asc')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

/**
 * Register a child for a session.
 * Atomically checks capacity and either confirms or waitlists.
 * Returns { status: 'confirmed' | 'waitlisted', registrationId }
 */
export async function registerForSession({
  sessionId,
  parentName,
  childName,
  lineUserId,
  email,
  forceWaitlist = false,
}) {
  const token = crypto.randomUUID();

  return runTransaction(db, async (tx) => {
    const sRef = sessionRef(sessionId);
    const sessionSnap = await tx.get(sRef);
    if (!sessionSnap.exists()) throw new Error('セッションが存在しません');

    const session = sessionSnap.data();
    const isFull = session.confirmedCount >= session.capacity;
    const status = isFull || forceWaitlist ? 'waitlisted' : 'confirmed';
    const waitlistPosition = status === 'waitlisted' ? session.waitlistCount + 1 : null;

    const regRef = doc(registrationsRef());
    tx.set(regRef, {
      sessionId,
      parentName: parentName || null,
      childName,
      lineUserId: lineUserId || null,
      email: email || null,
      status,
      waitlistPosition,
      notificationToken: token,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (status === 'confirmed') {
      tx.update(sRef, { confirmedCount: increment(1) });
    } else {
      tx.update(sRef, { waitlistCount: increment(1) });
    }

    return { status, registrationId: regRef.id, waitlistPosition };
  });
}

/**
 * Cancel a registration.
 * If confirmed, tries to promote the first waitlisted entry.
 * Returns the promoted registration (if any) for notification.
 */
export async function cancelRegistration(registrationId) {
  return runTransaction(db, async (tx) => {
    const rRef = registrationRef(registrationId);
    const rSnap = await tx.get(rRef);
    if (!rSnap.exists()) throw new Error('登録が存在しません');

    const reg = rSnap.data();
    const wasConfirmed = reg.status === 'confirmed';

    tx.update(rRef, { status: 'cancelled', updatedAt: serverTimestamp() });

    const sRef = sessionRef(reg.sessionId);
    if (wasConfirmed) {
      tx.update(sRef, { confirmedCount: increment(-1) });
    } else {
      tx.update(sRef, { waitlistCount: increment(-1) });
    }

    // Find first waitlisted entry (ordered by createdAt — handled server-side)
    let promoted = null;
    if (wasConfirmed) {
      const wq = query(
        registrationsRef(),
        where('sessionId', '==', reg.sessionId),
        where('status', '==', 'waitlisted'),
        orderBy('waitlistPosition', 'asc')
      );
      const wSnap = await getDocs(wq);
      if (!wSnap.empty) {
        const first = wSnap.docs[0];
        promoted = { id: first.id, ...first.data() };
        // Mark as pending_upgrade so the notification function picks it up
        tx.update(doc(registrationsRef(), first.id), {
          status: 'pending_upgrade',
          updatedAt: serverTimestamp(),
        });
        tx.update(sRef, { waitlistCount: increment(-1) });
      }
    }

    return { promoted, sessionId: reg.sessionId };
  });
}

/**
 * Respond to an upgrade offer (via token link).
 * accept=true  → confirm the registration
 * accept=false → decline and promote the next person
 */
export async function respondToUpgrade(notificationToken, accept) {
  // Find the registration by token
  const q = query(
    registrationsRef(),
    where('notificationToken', '==', notificationToken),
    where('status', '==', 'pending_upgrade')
  );
  const snap = await getDocs(q);
  if (snap.empty) return { success: false, message: '無効または期限切れのリンクです' };

  const regDoc = snap.docs[0];
  const reg = { id: regDoc.id, ...regDoc.data() };

  return runTransaction(db, async (tx) => {
    const rRef = registrationRef(reg.id);
    const sRef = sessionRef(reg.sessionId);

    if (accept) {
      tx.update(rRef, { status: 'confirmed', waitlistPosition: null, updatedAt: serverTimestamp() });
      tx.update(sRef, { confirmedCount: increment(1) });
      return { success: true, accepted: true };
    } else {
      tx.update(rRef, { status: 'cancelled', updatedAt: serverTimestamp() });

      // Promote next waitlisted
      const wq = query(
        registrationsRef(),
        where('sessionId', '==', reg.sessionId),
        where('status', '==', 'waitlisted'),
        orderBy('waitlistPosition', 'asc')
      );
      const wSnap = await getDocs(wq);
      let nextPromoted = null;
      if (!wSnap.empty) {
        const next = wSnap.docs[0];
        nextPromoted = { id: next.id, ...next.data() };
        tx.update(doc(registrationsRef(), next.id), {
          status: 'pending_upgrade',
          updatedAt: serverTimestamp(),
        });
        tx.update(sRef, { waitlistCount: increment(-1) });
      }
      return { success: true, accepted: false, nextPromoted };
    }
  });
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

export async function getAllRegistrationsForSession(sessionId) {
  const q = query(
    registrationsRef(),
    where('sessionId', '==', sessionId),
    orderBy('createdAt', 'asc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function setAdminPin(pin) {
  localStorage.setItem('admin_pin', pin);
}

export function getAdminPin() {
  return localStorage.getItem('admin_pin') || import.meta.env.VITE_ADMIN_PIN || '1234';
}
