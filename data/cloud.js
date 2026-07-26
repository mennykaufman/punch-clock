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
  signInWithRedirect,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDQXhynPNzqfKfLF4dTZiNIqrP3UQzM_HU",
  authDomain: "mennys-punch-clock.firebaseapp.com",
  projectId: "mennys-punch-clock",
  storageBucket: "mennys-punch-clock.firebasestorage.app",
  messagingSenderId: "817102912808",
  appId: "1:817102912808:web:484958adc478241fa3241d",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export function signInWithGoogle() {
  return signInWithRedirect(auth, new GoogleAuthProvider());
}

// Fires once immediately with the current signed-in user (or null), then again on every
// future sign-in/out — this is the single source of truth for auth state, and also covers
// the moment the page comes back from signInWithRedirect's full-page Google sign-in flow.
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
