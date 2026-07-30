import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  collection,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  deleteUser,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getAnalytics, logEvent, isSupported as isAnalyticsSupported } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyDQXhynPNzqfKfLF4dTZiNIqrP3UQzM_HU",
  authDomain: "mennys-punch-clock.firebaseapp.com",
  projectId: "mennys-punch-clock",
  storageBucket: "mennys-punch-clock.firebasestorage.app",
  messagingSenderId: "817102912808",
  appId: "1:817102912808:web:484958adc478241fa3241d",
  // Fill this in from Firebase Console > Project Settings > General > Your apps,
  // after linking Google Analytics to the project (see setup instructions).
  measurementId: "",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Analytics is best-effort: it needs a measurementId (only present once Analytics
// is linked in the Firebase Console) and isn't supported in every environment
// (e.g. some in-app browsers), so every failure here is swallowed silently rather
// than ever breaking the app itself.
let analytics = null;
if (firebaseConfig.measurementId) {
  isAnalyticsSupported()
    .then((supported) => {
      if (supported) analytics = getAnalytics(app);
    })
    .catch(() => {});
}

export function logAnalyticsEvent(eventName, params) {
  if (!analytics) return;
  try {
    logEvent(analytics, eventName, params);
  } catch (err) {
    console.error("analytics log failed:", err);
  }
}

// Popup (not redirect) — redirect requires relaying the result back through the
// firebaseapp.com auth domain, which browser storage restrictions on a custom domain
// like GitHub Pages can break, causing an endless "sign in -> bounced back" loop.
// Popup keeps everything in the same tab lineage and doesn't have that problem.
export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  return result.user;
}

// Fires once immediately with the current signed-in user (or null), then again on
// every future sign-in/out — the single source of truth for auth state.
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signOutUser() {
  return signOut(auth);
}

function userRef(employeeId) {
  return doc(db, "users", employeeId);
}

// Returns the stored document, or null if this employeeId has never been used before.
export async function fetchUserData(employeeId) {
  const snap = await getDoc(userRef(employeeId));
  return snap.exists() ? snap.data() : null;
}

export async function saveUserData(employeeId, data) {
  await setDoc(userRef(employeeId), data);
}

// Permanently removes the Firebase Auth account first, then its Firestore data —
// deliberately in that order. deleteUser can throw "auth/requires-recent-login" if
// the session is old, and if that happens we must NOT have already deleted the
// Firestore doc, or the account is left in a broken half-deleted state: data gone,
// but the Auth account (and the ability to sign back into it) still very much alive.
// The caller should catch that error specifically and ask the user to sign in again
// before retrying, rather than treating it as a generic failure.
export async function deleteUserAccount(employeeId) {
  if (auth.currentUser) {
    await deleteUser(auth.currentUser);
  }
  await deleteDoc(userRef(employeeId));
}

// Fires immediately with the current data, then again whenever it changes on any device.
export function subscribeToUserData(employeeId, onData) {
  return onSnapshot(userRef(employeeId), (snap) => {
    if (snap.exists()) onData(snap.data());
  });
}

function scheduleRef(uidKey) {
  return doc(db, "schedules", uidKey);
}

// A paste always replaces the whole week's shifts (never merges), so there's
// no partial-update ambiguity, and a colleague who stops sharing simply ages
// out once none of their stored shifts fall in the current week anymore.
export async function saveMySchedule(uidKey, { displayName, department, shifts }) {
  await setDoc(scheduleRef(uidKey), {
    uid: uidKey,
    displayName,
    department,
    updatedAt: new Date().toISOString(),
    shifts,
  });
}

// Fires immediately with every colleague's schedule doc in the same department,
// then again whenever any of them updates theirs — mirrors subscribeToUserData.
export function subscribeToDepartmentSchedules(department, onData) {
  const q = query(collection(db, "schedules"), where("department", "==", department));
  return onSnapshot(q, (snap) => onData(snap.docs.map((d) => d.data())));
}
