import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
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
  14600DJCP6: "",
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

// Fires immediately with the current data, then again whenever it changes on any device.
export function subscribeToUserData(employeeId, onData) {
  return onSnapshot(userRef(employeeId), (snap) => {
    if (snap.exists()) onData(snap.data());
  });
}
