import { SHIFT_CATALOG, matchShiftByClockIn, matchShiftByActualEnd } from "./data/shifts.js";
import { calculatePay, isProductivityBonusEligible, BASE_WAGE_ILS } from "./data/payRules.js";
import {
  fetchUserData,
  saveUserData,
  subscribeToUserData,
  signInWithGoogle,
  onAuthChange,
  signOutUser,
  deleteUserAccount,
  logAnalyticsEvent,
  saveMySchedule,
  subscribeToDepartmentSchedules,
  fetchAllUsers,
  updateUserRole,
  setUserActive,
  subscribeToFeatureFlags,
  setFeatureFlagLevel,
  sendResetPasswordEmail,
} from "./data/cloud.js";
import { parseScheduleSms } from "./data/scheduleParser.js";

function defaultState(employmentStartDate = "", idfBonusPercent = 0) {
  return {
    seq: 0, // bumped on every local save so a late/out-of-order cloud snapshot can never clobber a newer local change
    settings: {
      firstName: "",
      lastName: "",
      department: "",
      role: "user", // "user" | "beta" | "admin" — gates access to experimental features like Who's On Clock
      isFirstLogin: true, // drives the one-time guided tour; existing accounts never get this field, so it's falsy for them
      employmentStartDate,
      idfBonusPercent, // 0 = not eligible, else 2 or 3
      productivityBonusOverride: null, // null = auto (3-month rule), true/false = manual override
      baseWageILS: BASE_WAGE_ILS,
      remindPointsOnClockOut: true,
      trackShiftType: false, // optional per-user: tag each shift with a station/role
      theme: "system", // "system" | "dark" | "light"
      monthlyHoursGoal: 0, // 0 = no goal set
      moreWidgets: { hours: true, shifts: true, pay: true, averages: true, luba: true, export: true },
      // New accounts sign up through the tos-checkbox-gated flow, so they've already
      // agreed to whatever's current at creation time — no re-consent banner for them.
      termsAcceptedVersion: TERMS_VERSION,
      termsAcceptedAt: new Date().toISOString(),
      // Set the first time the user accepts the separate Who's In sharing-consent
      // screen (see maybeShowShareConsentScreen) — null until then.
      shareConsentAcceptedAt: null,
    },
    currentPunch: null, // { clockInISO, shift: {start,end,vouchers,points} }
    punches: [], // completed punches
    cafeteriaSpending: [], // { id, timestampISO, pointsSpent, note }
  };
}

function localCacheKey(uidKey) {
  return `punchclock_state_${uidKey}`;
}

function loadLocalCache(uidKey) {
  const raw = localStorage.getItem(localCacheKey(uidKey));
  return raw ? JSON.parse(raw) : null;
}

function saveLocalCache(uidKey, data) {
  localStorage.setItem(localCacheKey(uidKey), JSON.stringify(data));
}

let currentUid = null; // the signed-in Google account's uid — the Firestore document key
let currentUserLabel = ""; // email/name, for display only
let currentUserEmail = ""; // just the email (or "" if unavailable) — stored on the user doc so admin search can find people by it
let state = null;
let unsubscribeCloud = null;
let applyingRemoteUpdate = false;
let unsubscribeDeptSchedules = null;
let colleagueSchedules = []; // every schedule doc (including our own) in the current department
let deptSyncedFor = null;
let unsubscribeFeatureFlags = null;
// Default matches the original hardcoded behavior, so nothing changes for
// anyone until an admin actually opens the Feature Flags panel and touches it.
let featureFlags = {
  whosOnClock: { user: false, beta: true, admin: true },
  // Admin-only while the underlying pay formula is being re-verified against real
  // payslips (a discovered ~11-15% deviation) — widen this once payroll confirms the fix.
  salarySimulator: { user: false, beta: false, admin: true },
};
const KNOWN_FEATURES = { whosOnClock: "Who's in?", salarySimulator: "Salary Simulator" };

// ---------- guided tour sandbox ----------
// Every mutating action in the app already funnels through saveState() —
// this is the one choke point that needs to know a tour is running, so
// none of the actual clock-in/shift-pick/points-log business logic needs
// any tour-awareness at all: it just operates on whatever `state` points to.
let tourActive = false;
let tourRealState = null;

function enterTourSandbox() {
  tourRealState = state;
  state = JSON.parse(JSON.stringify(state));
  tourActive = true;
}

function exitTourSandbox() {
  state = tourRealState;
  tourRealState = null;
  tourActive = false;
  renderHome();
  renderHistory();
  renderCafeteria();
  renderSettings();
  if (!document.getElementById("screen-whosonclock").hidden) renderWhosOnClock();
}

function saveState() {
  if (tourActive) return; // sandboxed actions during the tour never persist
  if (!currentUid) return;
  if (!applyingRemoteUpdate) state.seq = (state.seq || 0) + 1;
  saveLocalCache(currentUid, state);
  if (!applyingRemoteUpdate) {
    saveUserData(currentUid, state).catch((err) => {
      console.error("cloud save failed:", err);
      // Offline: Firestore's own local cache queues this write and retries
      // automatically once the connection comes back, so nothing else to do here.
    });
  }
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// Guards against a Firestore call hanging forever (observed when logging back in shortly
// after logging out, mid-subscription-teardown) — without this, the login button would be
// stuck indefinitely with no way to recover short of reloading the page.
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// ---------- auth / session ----------

const splashScreen = document.getElementById("splash-screen");
const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginError = document.getElementById("login-error");
const btnGoogleSignIn = document.getElementById("btn-google-signin");
const googleSignInCard = document.getElementById("google-signin-card");
const tosCheckbox = document.getElementById("tos-checkbox");
const btnViewTos = document.getElementById("btn-view-tos");
const btnViewTosSettings = document.getElementById("btn-view-tos-settings");
const welcomeCard = document.getElementById("welcome-card");
const welcomeFirstName = document.getElementById("welcome-first-name");
const welcomeLastName = document.getElementById("welcome-last-name");
const welcomeDepartment = document.getElementById("welcome-department");
const welcomeEmploymentStartDate = document.getElementById("welcome-employment-start-date");
const welcomeIdfEligible = document.getElementById("welcome-idf-eligible");
const welcomeIdfPercent = document.getElementById("welcome-idf-percent");
const welcomeError = document.getElementById("welcome-error");
const btnWelcomeContinue = document.getElementById("btn-welcome-continue");

function showLoginScreen() {
  splashScreen.hidden = true;
  loginScreen.hidden = false;
  appShell.hidden = true;
  document.getElementById("deactivated-screen").hidden = true;
  googleSignInCard.hidden = false;
  welcomeCard.hidden = true;
}

function showWelcomeCard() {
  splashScreen.hidden = true;
  loginScreen.hidden = false;
  appShell.hidden = true;
  document.getElementById("deactivated-screen").hidden = true;
  googleSignInCard.hidden = true;
  welcomeCard.hidden = false;
}

function showAppShell() {
  splashScreen.hidden = true;
  loginScreen.hidden = true;
  appShell.hidden = false;
  document.getElementById("deactivated-screen").hidden = true;
}

function showDeactivatedScreen() {
  splashScreen.hidden = true;
  loginScreen.hidden = true;
  appShell.hidden = true;
  document.getElementById("deactivated-screen").hidden = false;
}

// Subscribes to this account's cloud document so changes made on any other
// device show up here automatically too.
function startCloudSync(uidKey) {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = subscribeToUserData(uidKey, (data) => {
    // An admin deactivating this account mid-session must take effect
    // immediately, regardless of seq ordering (setUserActive never bumps seq).
    if (data?.settings?.active === false) {
      handleLogout();
      showDeactivatedScreen();
      return;
    }

    // A snapshot can arrive late/out-of-order relative to our own rapid local
    // writes (e.g. clock-in immediately followed by an edit); only accept it
    // if it isn't older than what we already have, so it can never clobber a
    // newer local change with stale data (from this device or another one).
    if ((data.seq || 0) < (state?.seq || 0)) return;

    applyingRemoteUpdate = true;
    state = data;
    saveLocalCache(uidKey, state);
    renderHome();
    renderHistory();
    renderCafeteria();
    renderSettings();
    applyingRemoteUpdate = false;
    if (state.settings.department !== deptSyncedFor) startDeptScheduleSync(state.settings.department);
    applyRoleVisibility();
  });
}

// Subscribes to every colleague's schedule doc in the given department so
// "Who's On Clock" updates live as people paste/replace their weekly shifts.
function startDeptScheduleSync(department) {
  if (unsubscribeDeptSchedules) unsubscribeDeptSchedules();
  deptSyncedFor = department;
  if (!department) {
    colleagueSchedules = [];
    return;
  }
  unsubscribeDeptSchedules = subscribeToDepartmentSchedules(department, (docs) => {
    colleagueSchedules = docs;
    if (!document.getElementById("screen-whosonclock").hidden) renderWhosOnClock();
  });
}

// Fires once at sign-in and lives for the whole session — every signed-in
// user needs this (not just admins), since it decides what they themselves
// can see. Feature-gated visibility is admin-controlled from the Feature
// Flags panel, replacing what used to be a hardcoded role check.
function startFeatureFlagsSync() {
  if (unsubscribeFeatureFlags) unsubscribeFeatureFlags();
  unsubscribeFeatureFlags = subscribeToFeatureFlags((flags) => {
    featureFlags = { ...featureFlags, ...flags };
    applyRoleVisibility();
    refreshAdminDashboardIfOpen();
  });
}

// Shared by every feature-flag gated feature (Who's In, Salary Simulator, and any
// future one): a feature enabled for "beta" is automatically visible to admin too
// (admin always sees everything a beta tester can), even if its own "admin" toggle
// was never separately switched on.
function canSeeFeature(key, role) {
  const flags = featureFlags[key] || {};
  return !!flags[role] || (role === "admin" && !!flags.beta);
}

// Who's On Clock's visibility (and any future gated feature) is looked up
// dynamically from featureFlags rather than hardcoded, so an admin can widen
// or narrow the rollout from the Feature Flags panel without a code change.
// A feature enabled for "beta" always carries just the "BETA" tag — admin never gets
// its own separate "ADMIN" label on a per-feature nav badge like this one.
function applyRoleVisibility() {
  const role = state?.settings?.role || "user";
  const wocFlags = featureFlags.whosOnClock || {};
  document.querySelector('[data-nav="whosonclock"]').hidden = !canSeeFeature("whosOnClock", role);

  const navBadge = document.getElementById("nav-beta-badge");
  navBadge.hidden = !wocFlags.beta;
  navBadge.textContent = "BETA";

  const accountBadge = document.getElementById("account-role-badge");
  const isBetaOrAdmin = role === "beta" || role === "admin";
  accountBadge.hidden = !isBetaOrAdmin;
  accountBadge.textContent = role === "admin" ? "ADMIN" : "BETA";
  accountBadge.classList.toggle("role-admin", role === "admin");
  accountBadge.classList.toggle("role-beta", role !== "admin");
}

// ---------- toast ----------

const toastEl = document.getElementById("toast");
let toastHideTimer = null;

function showToast(message, isError = false) {
  clearTimeout(toastHideTimer);
  toastEl.textContent = message;
  toastEl.classList.toggle("toast-error", isError);
  toastEl.classList.add("show");
  toastHideTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// ---------- admin dashboard ----------
// A dedicated modal (reusing the same shared modal shell as everything else in the
// app) rather than an inline Settings section — keeps admin-only logic and its DOM
// fully separate from the regular Settings screen, and out of a non-admin's way.

let adminUsersCache = [];
let adminDashboardActiveTab = null; // tracks which tab is open so a live feature-flag
                                     // update from another admin session can re-render it
let adminDashboardContentArea = null;

// Called from startFeatureFlagsSync whenever the flags doc changes on the server — if
// this admin currently has the Feature Flags tab open, redraw it with the fresh data
// (e.g. another admin toggling something in a second tab/device shows up live here too).
function refreshAdminDashboardIfOpen() {
  if (adminDashboardActiveTab === "flags" && adminDashboardContentArea) {
    adminDashboardContentArea.innerHTML = "";
    renderFeatureFlagsTab(adminDashboardContentArea);
  }
}

function openAdminDashboardModal(initialTab = "users") {
  // Defense in depth: the launch button is already hidden for non-admins, but this
  // guards the entry point itself too, in case it's ever called from anywhere else.
  if ((state.settings.role || "user") !== "admin") return;

  openModal("🛡️ Admin Dashboard");

  const tabBar = document.createElement("div");
  tabBar.className = "segmented-control";
  const usersTabBtn = document.createElement("button");
  usersTabBtn.type = "button";
  usersTabBtn.className = "segmented-option";
  usersTabBtn.textContent = "👥 Users";
  const flagsTabBtn = document.createElement("button");
  flagsTabBtn.type = "button";
  flagsTabBtn.className = "segmented-option";
  flagsTabBtn.textContent = "🚩 Feature Flags";
  tabBar.append(usersTabBtn, flagsTabBtn);

  const contentArea = document.createElement("div");
  modalBody.append(tabBar, contentArea);

  adminDashboardContentArea = contentArea;

  function showTab(tab) {
    adminDashboardActiveTab = tab;
    usersTabBtn.classList.toggle("active", tab === "users");
    flagsTabBtn.classList.toggle("active", tab === "flags");
    contentArea.innerHTML = "";
    if (tab === "users") renderAdminUsersTab(contentArea);
    else renderFeatureFlagsTab(contentArea);
  }

  usersTabBtn.addEventListener("click", () => showTab("users"));
  flagsTabBtn.addEventListener("click", () => showTab("flags"));
  showTab(initialTab);

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);

  const inviteBtn = document.createElement("button");
  inviteBtn.className = "btn-plain";
  inviteBtn.textContent = "🔗 Invite friends";
  inviteBtn.addEventListener("click", () => {
    closeModal();
    openInviteModal();
  });

  modalActions.append(closeBtn, inviteBtn);
}

// 👥 User Management tab: real-time search, active/inactive filter, and per-user
// quick actions (reset password, block/unblock, role change).
function renderAdminUsersTab(container) {
  const searchInput = document.createElement("input");
  searchInput.className = "field-input";
  searchInput.type = "text";
  searchInput.placeholder = "Search by name, email, or role…";

  const inactiveRow = document.createElement("div");
  inactiveRow.className = "switch-row";
  const inactiveLabel = document.createElement("span");
  inactiveLabel.textContent = "Show inactive/blocked users";
  const inactiveToggleLabel = document.createElement("label");
  inactiveToggleLabel.className = "toggle-switch";
  const inactiveToggle = document.createElement("input");
  inactiveToggle.type = "checkbox";
  const inactiveSlider = document.createElement("span");
  inactiveSlider.className = "toggle-slider";
  inactiveToggleLabel.append(inactiveToggle, inactiveSlider);
  inactiveRow.append(inactiveLabel, inactiveToggleLabel);

  const list = document.createElement("ul");
  list.className = "list";

  container.append(searchInput, inactiveRow, list);

  function renderFiltered() {
    const searchTerm = searchInput.value.trim().toLowerCase();
    const showInactive = inactiveToggle.checked;

    if (!adminUsersCache.length) {
      list.innerHTML = `<li class="list-empty">No users found</li>`;
      return;
    }

    const filtered = adminUsersCache.filter((u) => {
      const active = u.settings?.active !== false;
      if (!active && !showInactive) return false;
      if (!searchTerm) return true;
      const name = `${u.settings?.firstName || ""} ${u.settings?.lastName || ""}`.trim().toLowerCase();
      const email = (u.settings?.email || "").toLowerCase();
      const role = (u.settings?.role || "user").toLowerCase();
      return name.includes(searchTerm) || email.includes(searchTerm) || role.includes(searchTerm);
    });

    list.innerHTML = "";
    if (!filtered.length) {
      list.innerHTML = `<li class="list-empty">No users match your search</li>`;
      return;
    }

    for (const u of filtered) {
      const name = `${u.settings?.firstName || ""} ${u.settings?.lastName || ""}`.trim() || u.uid;
      const email = u.settings?.email || "";
      const role = u.settings?.role || "user";
      const active = u.settings?.active !== false;
      const isSelf = u.uid === currentUid;

      const li = document.createElement("li");
      li.className = "admin-user-card";

      const nameP = document.createElement("p");
      nameP.className = "admin-user-name";
      nameP.textContent = active ? name : `${name} (blocked)`;
      li.appendChild(nameP);

      if (email) {
        const emailP = document.createElement("p");
        emailP.className = "admin-user-email";
        emailP.textContent = email;
        li.appendChild(emailP);
      }

      const actions = document.createElement("div");
      actions.className = "admin-user-actions";

      const select = document.createElement("select");
      select.className = "admin-role-select";
      select.innerHTML = `<option value="user">user</option><option value="beta">beta</option><option value="admin">admin</option>`;
      select.value = role;
      if (isSelf) {
        // Never let an admin change their OWN role from here — same unrecoverable
        // self-lockout risk as deactivating themselves (see the block-button guard
        // below), just via a different field. With no other admin around, demoting
        // yourself here would require editing Firestore by hand to undo.
        select.disabled = true;
      } else {
        select.addEventListener("change", async () => {
          select.disabled = true;
          try {
            await updateUserRole(u.uid, select.value);
            u.settings.role = select.value; // keep the cache in sync so search/filter stays correct
            showToast(`${name}'s role changed to ${select.value}`);
          } catch (err) {
            console.error("role update failed:", err);
            select.value = role;
            showToast("Couldn't update role", true);
          } finally {
            select.disabled = false;
          }
        });
      }
      actions.appendChild(select);

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "admin-chip-btn";
      resetBtn.textContent = "🔑 Reset password";
      resetBtn.disabled = !email;
      resetBtn.title = email ? "" : "No email on file for this account";
      resetBtn.addEventListener("click", async () => {
        resetBtn.disabled = true;
        try {
          await sendResetPasswordEmail(email);
          showToast(`Reset email sent to ${email}`);
        } catch (err) {
          console.error("password reset failed:", err);
          showToast("Couldn't send reset email", true);
        } finally {
          resetBtn.disabled = false;
        }
      });
      actions.appendChild(resetBtn);

      if (isSelf) {
        // Never let an admin block/deactivate their own account from here — with
        // no other admin around, that's an unrecoverable self-lockout (the only
        // fix would be editing Firestore by hand).
        const youTag = document.createElement("span");
        youTag.className = "field-hint";
        youTag.textContent = "(you)";
        actions.appendChild(youTag);
      } else {
        const blockBtn = document.createElement("button");
        blockBtn.type = "button";
        blockBtn.className = active ? "admin-chip-btn danger" : "admin-chip-btn";
        blockBtn.textContent = active ? "🚫 Block" : "✅ Unblock";
        blockBtn.addEventListener("click", async () => {
          blockBtn.disabled = true;
          try {
            await setUserActive(u.uid, !active);
            u.settings.active = !active; // keep the cache in sync, no need to re-fetch everyone
            showToast(active ? `${name} blocked` : `${name} unblocked`);
            renderFiltered();
          } catch (err) {
            console.error("active toggle failed:", err);
            showToast("Couldn't update user", true);
            blockBtn.disabled = false;
          }
        });
        actions.appendChild(blockBtn);
      }

      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  async function loadAdminUsers() {
    list.innerHTML = `<li class="list-empty">Loading…</li>`;
    try {
      adminUsersCache = await fetchAllUsers();
    } catch (err) {
      console.error("failed to load users:", err);
      list.innerHTML = `<li class="list-empty">Couldn't load users</li>`;
      throw err;
    }
  }

  searchInput.addEventListener("input", renderFiltered);
  inactiveToggle.addEventListener("change", renderFiltered);

  loadAdminUsers()
    .then(renderFiltered)
    .catch(() => {});
}

// 🚩 Feature Flags tab: each feature gets one rollout-level selector instead of three
// separate toggles — Off / Admin Only / Beta Users / All Users. A "beta" or wider level
// always implies admin can see it too (see canSeeFeature), so the level fully captures
// the {user, beta, admin} shape without the admin having to manage the underlying flags
// directly.
function flagsToLevel(flags) {
  if (flags?.user) return "all";
  if (flags?.beta) return "beta";
  if (flags?.admin) return "adminOnly";
  return "off";
}

function levelToFlags(level) {
  switch (level) {
    case "all": return { user: true, beta: true, admin: true };
    case "beta": return { user: false, beta: true, admin: true };
    case "adminOnly": return { user: false, beta: false, admin: true };
    default: return { user: false, beta: false, admin: false };
  }
}

function renderFeatureFlagsTab(container) {
  const list = document.createElement("ul");
  list.className = "list";
  container.appendChild(list);

  for (const [key, label] of Object.entries(KNOWN_FEATURES)) {
    const li = document.createElement("li");
    li.className = "list-item";

    const row = document.createElement("div");
    row.className = "admin-flag-row";

    const titleP = document.createElement("p");
    titleP.className = "list-item-title";
    titleP.style.margin = "0";
    titleP.textContent = label;

    const select = document.createElement("select");
    select.className = "admin-role-select";
    select.innerHTML = `
      <option value="off">Off</option>
      <option value="adminOnly">Admin Only</option>
      <option value="beta">Beta Users</option>
      <option value="all">All Users</option>
    `;
    select.value = flagsToLevel(featureFlags[key]);
    select.addEventListener("change", async () => {
      const previousLevel = flagsToLevel(featureFlags[key]);
      select.disabled = true;
      try {
        await setFeatureFlagLevel(key, levelToFlags(select.value));
        showToast(`${label} set to "${select.options[select.selectedIndex].textContent}"`);
      } catch (err) {
        console.error("feature flag update failed:", err);
        select.value = previousLevel;
        showToast("Couldn't update feature flag", true);
      } finally {
        select.disabled = false;
      }
    });

    row.append(titleP, select);
    li.appendChild(row);
    list.appendChild(li);
  }
}

tosCheckbox.addEventListener("change", () => {
  btnGoogleSignIn.disabled = !tosCheckbox.checked;
});

btnViewTos.addEventListener("click", () => openTermsModal());
btnViewTosSettings.addEventListener("click", () => openTermsModal());

btnGoogleSignIn.addEventListener("click", async () => {
  loginError.textContent = "";
  btnGoogleSignIn.disabled = true;
  btnGoogleSignIn.textContent = "Signing in…";
  try {
    const user = await signInWithGoogle(); // opens a popup; resolves once the user picks an account
    await handleAuthenticatedUser(user);
  } catch (err) {
    console.error("google sign-in failed:", err);
    loginError.textContent = err?.code === "auth/popup-closed-by-user"
      ? "Sign-in was closed before finishing — try again."
      : "Couldn't sign in with Google. Try again.";
  } finally {
    btnGoogleSignIn.disabled = !tosCheckbox.checked;
    btnGoogleSignIn.textContent = "Sign in with Google";
  }
});

welcomeIdfEligible.addEventListener("change", () => {
  welcomeIdfPercent.hidden = !welcomeIdfEligible.checked;
});

btnWelcomeContinue.addEventListener("click", async () => {
  welcomeError.textContent = "";

  const firstName = welcomeFirstName.value.trim();
  const lastName = welcomeLastName.value.trim();
  const department = welcomeDepartment.value;
  if (!firstName || !lastName || !department) {
    welcomeError.textContent = "Please fill in your first name, last name, and department.";
    return;
  }

  btnWelcomeContinue.disabled = true;
  btnWelcomeContinue.textContent = "Setting up…";
  try {
    const idfBonusPercent = welcomeIdfEligible.checked ? Number(welcomeIdfPercent.value) : 0;
    const newState = defaultState(welcomeEmploymentStartDate.value, idfBonusPercent);
    newState.settings.firstName = firstName;
    newState.settings.lastName = lastName;
    newState.settings.department = department;
    newState.settings.email = currentUserEmail;

    await withTimeout(saveUserData(currentUid, newState), 10000, "timed out creating account");
    state = newState;
    saveLocalCache(currentUid, state);
    startCloudSync(currentUid);
    startDeptScheduleSync(state.settings.department);
    startFeatureFlagsSync();
    applyRoleVisibility();
    showAppShell();
    renderHome();
    if (state.settings.isFirstLogin) startTour();
    logAnalyticsEvent("sign_up", { method: "google" });
  } catch (err) {
    console.error("welcome setup failed:", err);
    welcomeError.textContent = "Couldn't reach the server — check your internet connection and try again.";
  } finally {
    btnWelcomeContinue.disabled = false;
    btnWelcomeContinue.textContent = "Continue";
  }
});

async function handleAuthenticatedUser(user) {
  currentUid = user.uid;
  currentUserLabel = user.email || user.displayName || user.uid;
  currentUserEmail = user.email || "";
  try {
    const existing = await withTimeout(fetchUserData(user.uid), 10000, "timed out fetching account");
    if (existing?.settings?.active === false) {
      showDeactivatedScreen();
      return;
    }
    if (existing) {
      state = existing;
      // Backfill for accounts created before email was stored on the doc — lets
      // the admin search panel find them by email too, going forward.
      if (!state.settings.email && currentUserEmail) {
        state.settings.email = currentUserEmail;
        saveState();
      }
      migratePunchPayCalculations();
      reconcileOvertimeModelForRole();
      saveLocalCache(currentUid, state);
      startCloudSync(currentUid);
      startDeptScheduleSync(state.settings.department);
      startFeatureFlagsSync();
      applyRoleVisibility();
      showAppShell();
      renderHome();
      maybeShowTermsReconsentBanner();
      if (state.settings.isFirstLogin) startTour();
      logAnalyticsEvent("login", { method: "google" });
    } else {
      showWelcomeCard();
    }
  } catch (err) {
    console.error("post sign-in check failed:", err);
    // Offline (or the server just timed out) but this device has signed in before —
    // fall back to the last-synced local copy instead of blocking the user out
    // entirely. It'll pick back up with the cloud once startCloudSync gets a connection.
    const cached = loadLocalCache(user.uid);
    if (cached?.settings?.active === false) {
      // The cache can be stale, but never in the direction of hiding a deactivation —
      // otherwise a blocked user could bypass it just by forcing this fetch to fail
      // (e.g. going offline) and falling back to an old "active" local snapshot.
      showDeactivatedScreen();
      return;
    }
    if (cached) {
      state = cached;
      migratePunchPayCalculations();
      reconcileOvertimeModelForRole();
      startCloudSync(currentUid);
      startDeptScheduleSync(state.settings.department);
      startFeatureFlagsSync();
      applyRoleVisibility();
      showAppShell();
      renderHome();
      maybeShowTermsReconsentBanner();
      if (state.settings.isFirstLogin) startTour();
    } else {
      loginError.textContent = "Couldn't reach the server — check your internet connection and try again.";
      showLoginScreen();
    }
  }
}

function handleLogout() {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = null;
  if (unsubscribeDeptSchedules) unsubscribeDeptSchedules();
  unsubscribeDeptSchedules = null;
  colleagueSchedules = [];
  deptSyncedFor = null;
  if (unsubscribeFeatureFlags) unsubscribeFeatureFlags();
  unsubscribeFeatureFlags = null;
  if (clockTimerInterval) {
    clearInterval(clockTimerInterval);
    clockTimerInterval = null;
  }
  currentUid = null;
  currentUserLabel = "";
  state = null;
  loginError.textContent = "";
  signOutUser().catch(() => {});
  showLoginScreen();
}

function boot() {
  onAuthChange((user) => {
    if (user) {
      handleAuthenticatedUser(user);
    } else if (!state) {
      showLoginScreen();
    }
  });
}

// ---------- formatting helpers ----------

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function formatDate(date) {
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
}
function formatILS(n) {
  return `₪${n.toFixed(2)}`;
}
function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function sameMonth(dateA, dateB) {
  return dateA.getFullYear() === dateB.getFullYear() && dateA.getMonth() === dateB.getMonth();
}
function sameDay(dateA, dateB) {
  return sameMonth(dateA, dateB) && dateA.getDate() === dateB.getDate();
}
function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// ---------- navigation ----------

const SCREENS = ["home", "history", "cafeteria", "whosonclock", "settings"];
const TITLES = { home: "TrackO'clock", history: "Monthly Attendance", cafeteria: "Luba", whosonclock: "Who's on the Clock", settings: "Settings" };

function showScreen(name) {
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === name);
  });
  const topbarTitle = document.getElementById("topbar-title");
  if (name === "home") {
    topbarTitle.innerHTML = `Track<span class="o-bell">O</span>'clock`;
  } else {
    topbarTitle.textContent = TITLES[name];
  }
  document.getElementById("topbar-subtitle").hidden = name !== "home";
  logAnalyticsEvent("screen_view", { firebase_screen: name });
  if (name === "history") renderHistory();
  if (name === "cafeteria") renderCafeteria();
  if (name === "whosonclock") renderWhosOnClock();
  if (name === "settings") {
    renderSettings();
    hideSettingsSaveBar();
  }
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.nav));
});

// ---------- modal ----------

const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalActions = document.getElementById("modal-actions");

function closeModal() {
  modalBackdrop.hidden = true;
  modalBody.innerHTML = "";
  modalActions.innerHTML = "";
  // Whatever modal was open, it's gone now — stop tracking it for live refreshes
  // (harmless no-op if the Admin Dashboard wasn't the one open).
  adminDashboardActiveTab = null;
  adminDashboardContentArea = null;
  // Centralized reset: whichever modal was blocking backdrop-dismiss (if any) is gone
  // now too, so the next modal always starts dismissable by default. Without this, any
  // future code path that closes a modal without going through its own "agree" button
  // would leave backdrop-dismiss permanently disabled for the rest of the session.
  blockBackdropDismiss = false;
}

function openModal(title) {
  modalTitle.textContent = title;
  modalBody.innerHTML = "";
  modalActions.innerHTML = "";
  modalBackdrop.hidden = false;
}

// Set true only while a mandatory-acknowledgment screen (terms re-consent, share
// consent) is showing, so a backdrop click can't be used to dismiss it without the
// user actually choosing a button — every other modal in the app stays dismissable.
let blockBackdropDismiss = false;

modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop && !blockBackdropDismiss) closeModal();
});

// Bumped whenever the legal text below changes materially — drives the blocking
// re-consent banner for existing accounts (see maybeShowTermsReconsentBanner).
const TERMS_VERSION = "2026-08-01";

function openTermsModal(onClosed) {
  openModal("תנאי שימוש ומדיניות פרטיות");
  modalBody.innerHTML = `
    <div dir="rtl" style="text-align: right;">
      <p class="field-hint">עדכון אחרון: 01.08.2026</p>

      <h2 style="font-size: 18px; margin: 12px 0 4px;">חלק א' – תנאי שימוש</h2>

      <p><strong>1. מבוא והגדרות</strong><br/>
      ברוכים הבאים ל-TrackO'clock ("האפליקציה" או "השירות"). תנאי שימוש אלה ("התנאים") מהווים הסכם מחייב בינך ("המשתמש") לבין מפתח האפליקציה ("המפתח"). עצם ההרשמה או השימוש באפליקציה מהווה הסכמה מלאה לתנאים אלה ולמדיניות הפרטיות המצורפת.</p>
      <p>"נתוני משתמש" – כל מידע שהוזן על ידך באפליקציה, לרבות פרטי פרופיל, נתוני משמרות, תעריפי שכר, נקודות לובה ולוחות משמרות משותפים.<br/>
      "נקודות לובה" – יחידת מעקב פנימית לתיעוד עצמי של שימוש בהטבת ארוחות, כמפורט בסעיף 5.<br/>
      "מנהל מערכת" (Admin) ו-"משתמש בטא" (Beta) – רמות הרשאה מוגברות כמפורט בסעיף 7.</p>

      <p><strong>2. כשירות שימוש</strong><br/>
      השימוש באפליקציה מיועד לבגירים (מגיל 18 ומעלה) הכשירים להתקשר בהסכם מחייב לפי הדין הישראלי. ביצירת חשבון הנך מצהיר/ה כי הנך עומד/ת בתנאי זה.</p>

      <p><strong>3. מהות השירות – כלי לשימוש עצמי בלבד</strong><br/>
      TrackO'clock הינו כלי עזר אישי לשימוש עצמי (Self-Service) למעקב משמרות, הערכת שכר וניהול נקודות לובה. האפליקציה אינה מחוברת ואינה מסונכרנת עם כל מערכת נוכחות, שכר או משאבי אנוש של מעסיקך.</p>
      <p>הבהרה קריטית: האפליקציה אינה מערכת נוכחות רשמית, אינה מהווה דיווח נוכחות כחוק במקום העבודה, ואינה מהווה תלוש שכר רשמי, ייעוץ משפטי או ייעוץ חשבונאי. כל הנתונים המוצגים מבוססים אך ורק על מידע שהוזן באופן ידני או שנרשם בזמן אמת על ידך, ואין להם כל זיקה או אימות מול רישומי מעסיקך.</p>

      <p><strong>4. חישובי שכר – עקרונות, הנחות ומגבלות</strong><br/>
      מנוע החישוב באפליקציה מבצע חישוב הערכתי בלבד, בהתבסס על הכללים והנחות המפורטים להלן:</p>
      <p>סיווג שעות: שעות עבודה מסווגות אוטומטית לפי טווחי שעון קבועים (יום/ערב/לילה/שבת), לרבות כלל "היפוך לילה" לפיו משמרת החופפת בהיקף מהותי לשעות הלילה עשויה להיות מסווגת כולה כמשמרת לילה.<br/>
      שעות נוספות: מחושבות לפי מדרגות אחוזים קבועות מראש (למשל 130%/150%), בהתאם לסוג המשמרת.<br/>
      ניכוי הפסקה: משמרות מעל משך זמן מסוים מנוכות אוטומטית בזמן הפסקה בלתי-מתוגמל.<br/>
      בונוס ייעודי (למשל בונוס שירות/מילואים): מחושב לפי האחוז שהוגדר על ידך בהגדרות, ומוכפל על סך השכר המחושב.<br/>
      בונוס ותק: בונוס בשיעור של עד 10% מתווסף לחישוב השכר בהתאם לוותק ולהיקף שעות העבודה המצטבר, לפי קריטריונים הנקבעים על ידי המפתח מעת לעת.<br/>
      שכר הבסיס לשעה נקבע על ידך באופן ידני בהגדרות ואינו מאומת מול כל מקור חיצוני.</p>
      <p><strong>שכר ברוטו בלבד:</strong> כל הסכומים המוצגים באפליקציה הינם הערכת שכר ברוטו בלבד. האפליקציה אינה מחשבת ואינה מציגה ניכויי מס הכנסה, ביטוח לאומי, הפרשות פנסיוניות או כל ניכוי חובה אחר, ואינה מבחינה בין הסכמי העסקה, דירוגים או הסכמים קיבוציים שונים.</p>
      <p>מקור הפערים האפשריים: מאחר שהאפליקציה פועלת אך ורק על בסיס נתונים שהוזנו על ידך, וללא כל גישה לנתונים המצויים אצל מעסיקך בלבד (כגון ניכויים אישיים, זיכויי מס, תיקונים רטרואקטיביים או הסכמים אישיים), ייתכנו פערים בין הנתונים המוצגים באפליקציה לבין תלוש השכר הרשמי. פערים אלו נובעים מטבעו של הכלי ואינם בהכרח תוצאה של שגיאה.</p>
      <p>במקרה של אי-התאמה כאמור – רישומי מעסיקך ותלוש השכר הרשמי הם המחייבים והקובעים בלבד, ועל המשתמש לפנות לבירור מול מחלקת השכר או משאבי האנוש של מקום עבודתו. מפתח האפליקציה אינו נושא באחריות לפערים הנובעים מהיעדר גישה לנתוני המעסיק כאמור, מהנחות החישוב המפורטות לעיל, או מהזנת נתונים שגויים או חלקיים על ידי המשתמש. אין באמור כדי לגרוע מאחריות המפתח בגין רשלנות בפיתוח מנוע החישוב עצמו (להבדיל מפערי מידע מובנים), זדון, או הפרת חובת אבטחת מידע כאמור בחלק ב' להלן.</p>
      <p>כללי החישוב (לרבות אחוזי תוספות, מדרגות שעות נוספות והנחות המס) עשויים להשתנות מעת לעת בהתאם לעדכוני האפליקציה, ואינם מהווים התחייבות חוזית לגובה שכר כלשהו.</p>

      <p><strong>5. נקודות לובה</strong><br/>
      צבירה: נקודות לובה נצברות באופן אוטומטי עם השלמת משמרת, בהתאם לטבלה קבועה מראש הצמודה לכל סוג/משך משמרת.<br/>
      ניצול: ניצול נקודות מדווח באופן עצמאי על ידי המשתמש ("self-reported") ואינו מאומת או משוקלל מול כל מערכת קפיטריה או קופה חיצונית בפועל.<br/>
      ללא ערך כספי: נקודות הלובה הן מנגנון מעקב פנימי בלבד ואינן מהוות מטבע, שובר בעל ערך נקוב, או כל זכות קניינית אחרת. האפליקציה אינה אחראית למימוש בפועל של הנקודות מול כל גורם שלישי (כגון קפיטריית מקום העבודה).<br/>
      שמירת נתונים: יתרת הנקודות המוצגת מתעדכנת לפי החודש הנצפה, אך כלל הרישומים ההיסטוריים נשמרים במערכת ואינם נמחקים באופן אוטומטי.<br/>
      האפליקציה אינה כוללת מנגנון לעריכת יתרת נקודות של משתמש על ידי מנהל מערכת; פאנל הניהול מוגבל לניהול הרשאות חשבון בלבד.</p>

      <p><strong>6. שיתוף מידע בין משתמשים – "מי במשמרת"</strong><br/>
      פיצ'ר "מי במשמרת" מאפשר, בכפוף לשיתוף יזום ומודע מצדך של לוח המשמרות האישי שלך, חשיפת פרטי משמרות (תאריכים, שעות ותפקיד, ככל שהוזנו) בפני משתמשים אחרים המשויכים לאותה מחלקה באפליקציה. הצפייה בפרטי משמרות של משתמשים אחרים מותנית בכך שגם אתה שיתפת את לוח המשמרות שלך (הצגה הדדית).</p>
      <p>לפני הפעלת הפיצ'ר לראשונה, תוצג בפניך במסך ייעודי הודעת הסכמה המפרטת מהו המידע שישותף ולמי. אישור ההודעה נדרש פעם אחת בלבד, ותוקפו נמשך כל עוד הנך משתמש/ת בפיצ'ר. השליטה בשיתוף מתבצעת ישירות באמצעות עריכה או מחיקה עצמאית של רשומות המשמרות שלך במסך הנוכחות: ברגע שרשומת משמרת נמחקת על ידך, היא חדלה להיות גלויה למשתמשים אחרים.</p>
      <p>באחריותך לוודא כי אינך משתף מידע אישי רגיש נוסף מעבר לנדרש בעת שימוש בפיצ'ר זה (למשל בתיוגים חופשיים או בהערות טקסט).</p>

      <p><strong>7. רמות הרשאה</strong><br/>
      קיימות שלוש רמות הרשאה באפליקציה: משתמש רגיל (ברירת המחדל), משתמש בטא (גישה מוקדמת לפיצ'רים בפיתוח, העשויים להשתנות או להיות מוסרים ללא הודעה מוקדמת) ומנהל מערכת. הרשאות מנהל המערכת מוגבלות לניהול חשבונות משתמשים (חסימה, שחרור ושינוי תפקיד) ואינן כוללות גישה לעריכת נתוני שכר, משמרות או נקודות של משתמש אחר.</p>

      <p><strong>8. קניין רוחני</strong><br/>
      כל זכויות היוצרים, סימני המסחר, העיצוב, הממשק, הקוד והתוכן ב-TrackO'clock שייכים במלואם ובאופן בלעדי למפתח האפליקציה. אין להעתיק, לשכפל, להנדס לאחור (Reverse Engineer), להפיץ או לעשות שימוש מסחרי באפליקציה או בכל חלק ממנה ללא אישור מפורש ובכתב מהמפתח.</p>

      <p><strong>9. הגבלת אחריות</strong><br/>
      השירות ניתן כפי שהוא ("As-Is") וכפי שזמין ("As-Available"), ללא כל התחייבות לדיוק מוחלט, זמינות רציפה או העדר תקלות. מבלי לגרוע מהאמור בסעיף 4 לעיל, המפתח אינו אחראי לכל נזק עקיף, תוצאתי או היפותטי הנובע משימוש באפליקציה או הסתמכות על הנתונים המוצגים בה במקום על מסמכי השכר והנוכחות הרשמיים של מעסיקך. אין באמור כדי לפטור את המפתח מאחריות בגין רשלנות רבתי, זדון, או הפרת חובת אבטחת מידע.</p>

      <p><strong>10. שיפוי</strong><br/>
      המשתמש מתחייב לשפות את המפתח בגין כל נזק, הפסד או הוצאה (לרבות שכר טרחת עורך דין סביר) שייגרמו למפתח כתוצאה מהפרת תנאים אלה על ידי המשתמש, למעט ככל שהנזק נגרם כתוצאה ממעשה או מחדל של המפתח עצמו.</p>

      <p><strong>11. סיום שימוש ומחיקת חשבון</strong><br/>
      באפשרותך למחוק את חשבונך בכל עת דרך הגדרות האפליקציה. מחיקת החשבון הינה מיידית ובלתי הפיכה, וכוללת מחיקה של פרטי ההתחברות, פרופיל המשתמש וכלל היסטוריית המשמרות ונקודות הלובה השמורות תחת חשבונך.</p>
      <p><strong>שים/י לב:</strong> ככל ששיתפת בעבר לוח משמרות דרך פיצ'ר "מי במשמרת", נתונים אלה עשויים להיוותר זמינים במאגרי המערכת לאחר מחיקת חשבונך, שכן מדובר במידע ששותף באופן פעיל לצדדים אחרים. לבקשת מחיקה מלאה של מידע כאמור, יש לפנות אלינו בפרטי הקשר שבסעיף 15.</p>
      <p>המפתח שומר לעצמו את הזכות להשעות או לחסום גישה לחשבון במקרה של הפרת תנאים אלה, בכפוף להודעה סבירה ככל שהדבר אפשרי בנסיבות העניין.</p>

      <p><strong>12. שינויים בתנאים</strong><br/>
      המפתח רשאי לעדכן תנאים אלה מעת לעת. במקרה של שינוי מהותי, תינתן הודעה סבירה מראש (לרבות בתוך האפליקציה). המשך השימוש באפליקציה לאחר כניסת השינויים לתוקף מהווה הסכמה לתנאים המעודכנים.</p>

      <p><strong>13. דין וסמכות שיפוט</strong><br/>
      על תנאים אלה יחולו אך ורק דיני מדינת ישראל. סמכות השיפוט הבלעדית בכל עניין הנוגע לתנאים אלה תהא נתונה לבתי המשפט המוסמכים בתל אביב, ישראל.</p>

      <p><strong>14. נגישות</strong><br/>
      המפתח פועל להנגשת האפליקציה בהתאם לדרישות הדין. לפניות בנושא נגישות ניתן לפנות בפרטי הקשר המפורטים בסעיף 15.</p>

      <p><strong>15. יצירת קשר</strong><br/>
      לכל שאלה, פנייה או תלונה בנוגע לתנאים אלה, ניתן לפנות למני קאופמן (חוליה מיוחדת).</p>

      <h2 style="font-size: 18px; margin: 20px 0 4px;">חלק ב' – מדיניות פרטיות</h2>

      <p><strong>1. המידע שאנו אוספים</strong><br/>
      לצורך תפעול השירות, אנו אוספים את סוגי המידע הבאים:</p>
      <p>פרטי זיהוי: בעת התחברות באמצעות חשבון Google, מתקבלים מזהה משתמש ייחודי, שם וכתובת דוא"ל, לצורך אימות בלבד. אין אפשרות הרשמה בדוא"ל וסיסמה נפרדים.<br/>
      פרטי פרופיל: שם, מחלקה, תאריך תחילת העסקה, שכר בסיס לשעה, הגדרות בונוסים ויעדים אישיים, ככל שהוזנו על ידך.<br/>
      נתוני משמרות ושכר: זמני כניסה/יציאה, סוג משמרת, תיוגים חופשיים (ככל שהופעל המתג הרלוונטי), ונתוני החישוב הנגזרים מהם.<br/>
      נתוני נקודות לובה: רישומי צבירה וניצול, לרבות הערות טקסט חופשיות ככל שהוזנו.<br/>
      נתוני לוח משמרות משותף: ככל שבחרת לשתף לוח משמרות אישי דרך פיצ'ר "מי במשמרת", מידע זה נגיש למשתמשים אחרים באותה מחלקה באפליקציה.<br/>
      נתוני שימוש: בעתיד, ובכפוף להפעלה, ייתכן שייאספו נתוני שימוש אנונימיים לצורך שיפור השירות (ראו סעיף 4 להלן).</p>

      <p><strong>2. כיצד אנו משתמשים במידע</strong><br/>
      המידע משמש אך ורק לצורך תפעול השירות: הצגת נתונים, ביצוע חישובי הערכת השכר, ניהול נקודות הלובה, וסנכרון בין המכשירים שלך. אנו לא מוכרים, משכירים או מעבירים את המידע האישי שלך לצד שלישי לצורכי פרסום.</p>

      <p><strong>3. שיתוף מידע עם משתמשים אחרים</strong><br/>
      ככל שהפעלת את פיצ'ר "מי במשמרת" ואישרת את הודעת ההסכמה הייעודית המוצגת לפני הפעלתו הראשונה, פרטי המשמרות המשותפים (תאריכים, שעות ותפקיד) יהיו גלויים למשתמשים אחרים המשויכים לאותה מחלקה, ובאופן הדדי - הצפייה בפרטי משמרות של אחרים מותנית בכך שגם אתה שיתפת את שלך. ההסכמה ניתנת פעם אחת. אין מתג הפעלה/כיבוי נפרד לשיתוף; השליטה במידע המשותף מתבצעת ישירות באמצעות עריכה או מחיקה של רשומות המשמרות שלך, ומרגע מחיקת רשומה כאמור היא חדלה להיות גלויה למשתמשים אחרים.</p>

      <p><strong>4. ספקי משנה ושירותי צד שלישי</strong><br/>
      השירות משתמש בספקים ובשירותים הבאים לצורך תפעולו:</p>
      <p>Google Firebase Authentication – ניהול תהליך ההתחברות.<br/>
      Google Firebase Firestore – אחסון נתוני המשתמש בענן.<br/>
      Google Firebase Analytics – מוגדר בתשתית האפליקציה לצורך ניתוח שימוש עתידי; נכון למועד עדכון מסמך זה אינו פעיל בפועל. במידה ויופעל בעתיד, מדיניות זו תעודכן בהתאם ותכלול פירוט אירועי המידע הנאספים ואפשרות סירוב (Opt-Out).<br/>
      ספריות ייצוא קבצים (Excel/PDF) – פועלות באופן מקומי בדפדפן/במכשיר שלך בלבד, ואינן משדרות מידע לשרת חיצוני כלשהו.</p>
      <p>לא נעשה שימוש בשירותי פרסום, מעקב שיווקי, או שיתוף מידע עם רשתות חברתיות.</p>

      <p><strong>5. אחסון ואבטחת מידע</strong><br/>
      המידע שלך מאוחסן בשירותי הענן של Google Firebase, המשתמשים בפרוטוקולי הצפנה מקובלים בתעשייה. מיקום האחסון (Region): nam5 (אזור Multi-region בצפון אמריקה / ארה"ב).</p>
      <p>האפליקציה תומכת בעבודה אופליין: נתונים הנרשמים ללא חיבור לרשת נשמרים באופן מקומי במכשירך ומסונכרנים אוטומטית לשרת בעת חידוש החיבור. בנוסף, קבצי האפליקציה עצמם (להבדיל מנתוניך האישיים) מוטמנים במכשירך לצורך טעינה מהירה ותמיכה בסיסית במצב אופליין.</p>

      <p><strong>6. שמירה ומחיקת מידע</strong><br/>
      במחיקת חשבונך, נתוני הפרופיל, המשמרות ונקודות הלובה השמורים תחת חשבונך יימחקו לצמיתות ובאופן מיידי משרתינו וממכשירך. מידע ששיתפת באופן פעיל עם משתמשים אחרים (כגון דרך פיצ'ר "מי במשמרת") עשוי להיוותר במאגרי המערכת גם לאחר מחיקת חשבונך; לבקשת הסרה מלאה של מידע כאמור יש לפנות אלינו בפרטי הקשר שבסעיף 11.</p>

      <p><strong>7. עוגיות ואחסון מקומי</strong><br/>
      האפליקציה משתמשת באחסון מקומי (Local Storage) במכשירך לצורך שמירת עותק גיבוי של נתוניך ותמיכה בעבודה אופליין. אחסון זה אינו משמש למעקב פרסומי ואינו משותף עם צדדים שלישיים.</p>

      <p><strong>8. זכויות המשתמש</strong><br/>
      בהתאם לחוק הגנת הפרטיות, התשמ"א-1981, עומדות לך הזכויות הבאות:</p>
      <p>עיון במידע: ניתן לצפות בכלל המידע השמור אודותיך ישירות דרך מסכי האפליקציה.<br/>
      תיקון ועדכון: ניתן לערוך רשומות משמרת, נתוני פרופיל והגדרות בכל עת.<br/>
      מחיקה: ניתן למחוק רשומות בודדות או את מלוא החשבון, כמפורט בסעיף 6 לעיל.<br/>
      פנייה נוספת: לכל בקשה שאינה ניתנת לביצוע עצמאי דרך האפליקציה, ניתן לפנות בפרטי הקשר שבסעיף 11.</p>

      <p><strong>9. קטינים</strong><br/>
      השירות אינו מיועד למשתמשים מתחת לגיל 18.</p>

      <p><strong>10. שינויים במדיניות הפרטיות</strong><br/>
      מדיניות זו עשויה להתעדכן מעת לעת, לרבות בעקבות שינויים טכנולוגיים או רגולטוריים (כגון הפעלת Firebase Analytics בעתיד). על שינויים מהותיים תינתן הודעה בתוך האפליקציה.</p>

      <p><strong>11. יצירת קשר</strong><br/>
      לכל שאלה או בקשה בנוגע למדיניות פרטיות זו, ניתן לפנות למני קאופמן (חוליה מיוחדת).</p>
    </div>
  `;

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => {
    closeModal();
    if (onClosed) onClosed();
  });
  modalActions.appendChild(closeBtn);
}

// Existing accounts only — a brand-new signup gets termsAcceptedVersion set to the
// current TERMS_VERSION at creation time (see defaultState), so this is always a
// no-op for them. Called right after the app shell renders, in both the online and
// cached/offline sign-in paths.
function maybeShowTermsReconsentBanner() {
  if (state.settings.termsAcceptedVersion === TERMS_VERSION) return;
  showTermsReconsentBanner();
}

function showTermsReconsentBanner() {
  openModal("עודכנו תנאי השימוש שלנו");
  blockBackdropDismiss = true;
  modalBody.innerHTML = `
    <div dir="rtl" style="text-align: right;">
      <p>עדכנו את תנאי השימוש ומדיניות הפרטיות של TrackO'clock. השינויים כוללים הבהרות לגבי אופן חישוב השכר, מנגנון נקודות הלובה ופיצ'ר "מי במשמרת". יש צורך באישור מחדש כדי להמשיך להשתמש באפליקציה.</p>
    </div>
  `;

  const readFullBtn = document.createElement("button");
  readFullBtn.className = "btn-plain";
  readFullBtn.textContent = "קרא/י את התנאים המלאים";
  readFullBtn.addEventListener("click", () => {
    openTermsModal(() => showTermsReconsentBanner());
  });

  const agreeBtn = document.createElement("button");
  agreeBtn.className = "btn-primary";
  agreeBtn.textContent = "קראתי ואני מאשר/ת";
  agreeBtn.addEventListener("click", () => {
    state.settings.termsAcceptedVersion = TERMS_VERSION;
    state.settings.termsAcceptedAt = new Date().toISOString();
    saveState();
    closeModal();
  });

  modalActions.append(readFullBtn, agreeBtn);
}

// Gates the FIRST activation of "Who's In" schedule sharing behind a dedicated consent
// screen — separate from the general terms banner, with its own timestamp
// (shareConsentAcceptedAt). Once accepted, it's never shown again for this account.
// Unlike the terms banner, this isn't forced — declining just means not proceeding to
// onProceed (backdrop-click / navigating away works exactly like an implicit cancel).
function maybeShowShareConsentScreen(onProceed) {
  if (state.settings.shareConsentAcceptedAt) {
    onProceed();
    return;
  }

  openModal("שיתוף לוח המשמרות עם עמיתים למחלקה");
  modalBody.innerHTML = `
    <div dir="rtl" style="text-align: right;">
      <p>בהפעלת "מי במשמרת", אתה מאשר שיתוף פרטי המשמרות שלך (תאריכים, שעות ותפקיד) עם עמיתים אחרים באותה מחלקה שהצטרפו גם הם לפיצ'ר. השיתוף הדדי — תוכל לראות משמרות של עמיתים רק אם גם אתה משתף. ניתן להפסיק את השיתוף בכל עת על ידי מחיקת רשומות המשמרות שלך. לפרטים נוספים ניתן לקרוא במדיניות הפרטיות.</p>
    </div>
  `;

  const privacyBtn = document.createElement("button");
  privacyBtn.className = "btn-plain";
  privacyBtn.textContent = "מדיניות הפרטיות";
  privacyBtn.addEventListener("click", () => {
    openTermsModal(() => maybeShowShareConsentScreen(onProceed));
  });

  const agreeBtn = document.createElement("button");
  agreeBtn.className = "btn-primary";
  agreeBtn.textContent = "מאשר/ת";
  agreeBtn.addEventListener("click", () => {
    state.settings.shareConsentAcceptedAt = new Date().toISOString();
    saveState();
    closeModal();
    onProceed();
  });

  modalActions.append(privacyBtn, agreeBtn);
}

// ---------- shift matching UI ----------

function shiftLabel(shift) {
  return `${shift.start}–${shift.end} (${shift.vouchers}, ${shift.points} pts)`;
}

// ---------- optional shift type (station/role) tagging ----------

const SHIFT_TYPES = ["דלפק", "באגי יציאות", "דייל קונקורס", "באגי כניסות", "פסיפס", `דייל של"ן`];

// Resolves to a chosen shift type string, or "" if skipped/cleared.
function promptShiftType(current = "") {
  return new Promise((resolve) => {
    openModal("Shift type");
    for (const type of SHIFT_TYPES) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = type;
      if (type === current) btn.style.fontWeight = "800";
      btn.addEventListener("click", () => {
        closeModal();
        resolve(type);
      });
      modalBody.appendChild(btn);
    }
    const skipBtn = document.createElement("button");
    skipBtn.className = "btn-plain";
    skipBtn.textContent = "None / Skip";
    skipBtn.addEventListener("click", () => {
      closeModal();
      resolve("");
    });
    modalActions.appendChild(skipBtn);
  });
}

// Resolves to a chosen shift object, or null if the user cancels.
function resolveShiftForClockIn(clockInDate) {
  return new Promise((resolve) => {
    // During the guided tour, always show the full searchable picker instead
    // of the normal auto-match — guarantees a real, always-present list to
    // point the tour's step 2 at, regardless of whether "now" happens to be
    // ambiguous in the real catalog.
    if (tourActive) {
      resolveWithManualPicker(resolve);
      return;
    }

    const { candidates } = matchShiftByClockIn(clockInDate);

    if (candidates.length === 1) {
      resolve(candidates[0]);
      return;
    }

    // Multiple catalog rows share the nearest start time (e.g. several 18:00 shifts
    // with different lengths) — show only that short, focused set, with a small
    // escape hatch at the bottom for the rare case none of them fit.
    openModal("Which shift is this?");
    for (const shift of candidates) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = shiftLabel(shift);
      btn.addEventListener("click", () => {
        closeModal();
        resolve(shift);
      });
      modalBody.appendChild(btn);
    }
    const expandBtn = document.createElement("button");
    expandBtn.className = "btn-plain";
    expandBtn.textContent = "Show all shift types";
    expandBtn.addEventListener("click", () => {
      closeModal();
      resolveWithManualPicker(resolve);
    });
    modalActions.appendChild(expandBtn);
  });
}

function resolveWithManualPicker(resolve) {
  openModal("Pick your shift");
  const search = document.createElement("input");
  search.className = "field-input";
  search.type = "text";
  search.placeholder = "Search e.g. 08:00";
  modalBody.appendChild(search);

  const list = document.createElement("div");
  modalBody.appendChild(list);

  function renderList(filter) {
    list.innerHTML = "";
    const f = filter.trim();
    const rows = SHIFT_CATALOG.filter((s) => `${s.start}-${s.end}`.includes(f));
    for (const shift of rows.slice(0, 40)) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = shiftLabel(shift);
      btn.addEventListener("click", () => {
        closeModal();
        resolve(shift);
      });
      list.appendChild(btn);
    }
  }
  renderList("");
  search.addEventListener("input", () => renderList(search.value));
}

// ---------- clock in / out ----------

const clockBtn = document.getElementById("btn-clock");
const NO_POINTS_SHIFT_LABEL = "Shift without points eligibility";

clockBtn.addEventListener("click", async () => {
  if (state.currentPunch) {
    await handleClockOut();
  } else {
    await handleClockIn();
  }
});

async function handleClockIn() {
  const clockInDate = new Date();
  const shift = await resolveShiftForClockIn(clockInDate);
  if (!shift) return;
  let shiftType = "";
  if (state.settings.trackShiftType) {
    shiftType = await promptShiftType();
  }
  state.currentPunch = { clockInISO: clockInDate.toISOString(), shift, shiftType };
  saveState();
  renderHome();
  logAnalyticsEvent("clock_in", { shift_start: shift.start });
}

// Resolves the shift that actually applies given the real clock-out time:
//  1. If the actual end closely matches another catalog row (same start), use it silently.
//  2. Otherwise, ask which of that start's shifts this actually was (or "no points eligibility").
function resolveActualShift(pickedShift, clockOutDate) {
  return new Promise((resolve) => {
    const autoMatch = matchShiftByActualEnd(pickedShift.start, clockOutDate, 20);
    if (autoMatch) {
      resolve(autoMatch);
      return;
    }

    const candidates = SHIFT_CATALOG.filter((s) => s.start === pickedShift.start);
    openModal("Actual end time didn't match — which shift was this?");
    for (const shift of candidates) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = shiftLabel(shift);
      btn.addEventListener("click", () => {
        closeModal();
        resolve(shift);
      });
      modalBody.appendChild(btn);
    }
    const noPointsBtn = document.createElement("button");
    noPointsBtn.className = "btn-plain";
    noPointsBtn.textContent = NO_POINTS_SHIFT_LABEL;
    noPointsBtn.addEventListener("click", () => {
      closeModal();
      resolve({ start: pickedShift.start, end: formatTime(clockOutDate), points: 0, vouchers: "-" });
    });
    modalActions.appendChild(noPointsBtn);
  });
}

// Shared by live clock-out, edits, and the manual "More" entry form: given the final
// (already-resolved) shift and real clock-in/out times, computes pay and returns
// everything needed to save a punch record, including whether Luba points moved.
// The manual override (if set) always wins over the 3-month auto-calculation —
// lets a user correct the system if their real eligibility differs for any reason.
function currentProductivityBonusEnabled(referenceDate = new Date()) {
  const override = state.settings.productivityBonusOverride;
  if (override === true || override === false) return override;
  return isProductivityBonusEligible(state.settings.employmentStartDate, referenceDate);
}

// Admin-only rollout of the corrected night-shift thresholds (425min standard, 135min
// flip — see payRules.js header) — confirmed against one real minute-matched payslip
// shift so far, so it's opt-in by role rather than shown to every user yet.
function usesCorrectedOvertimeModel() {
  return (state.settings.role || "user") === "admin";
}

// Every existing punch has its pay FROZEN in payBreakdown/payILS from whenever it was
// originally saved. This re-runs calculatePay() once over every existing punch (same
// clock times, same wage/IDF-% each shift already had) so past months reflect whichever
// formula is currently live. Gated by a version flag bumped whenever the underlying
// formula changes, so it runs exactly once per account per formula version.
function migratePunchPayCalculations() {
  if (state.settings.payRulesMigrationV6 || !state.punches.length) {
    if (!state.settings.payRulesMigrationV6) state.settings.payRulesMigrationV6 = true;
    return;
  }
  for (const p of state.punches) {
    const old = p.payBreakdown;
    if (!old) continue;
    // One malformed record (corrupted dates, etc.) must not abort migration for every
    // other punch, or block this user from ever completing sign-in again.
    try {
      const recalculated = calculatePay(new Date(p.clockInISO), new Date(p.clockOutISO), {
        baseWageILS: old.baseWageILS,
        idfBonusPercent: old.idfBonusPercent || 0,
        useUpdatedNightThresholds: usesCorrectedOvertimeModel(),
      });
      p.payBreakdown = recalculated;
      p.payILS = recalculated.finalPayILS;
    } catch (err) {
      console.error("migratePunchPayCalculations: skipping unrecalculable punch", p.id, err);
    }
  }
  state.settings.payRulesMigrationV6 = true;
  saveState();
}

// migratePunchPayCalculations only ever runs ONCE per formula version — but which OT
// model applies depends on role, and role can change at any time (promotion/demotion),
// not just when the formula code changes. Without this, a role change would silently
// leave old punches frozen on whichever model was active when they were last migrated,
// while new punches (buildPunch checks role live) use the other one — a quiet mismatch
// within the same account with no error and no visible warning. Runs on every load but
// is a no-op unless a punch's stored model actually disagrees with the current role.
function reconcileOvertimeModelForRole() {
  const wantsCorrectedModel = usesCorrectedOvertimeModel();
  let anyChanged = false;
  for (const p of state.punches) {
    const old = p.payBreakdown;
    if (!old || !!old.usesUpdatedNightThresholds === wantsCorrectedModel) continue;
    try {
      const recalculated = calculatePay(new Date(p.clockInISO), new Date(p.clockOutISO), {
        baseWageILS: old.baseWageILS,
        idfBonusPercent: old.idfBonusPercent || 0,
        useUpdatedNightThresholds: wantsCorrectedModel,
      });
      p.payBreakdown = recalculated;
      p.payILS = recalculated.finalPayILS;
      anyChanged = true;
    } catch (err) {
      console.error("reconcileOvertimeModelForRole: skipping unrecalculable punch", p.id, err);
    }
  }
  if (anyChanged) saveState();
}

// Admin-only estimate (2026-08-01): the +10% seniority bonus, computed via the
// forensically-derived "2-month-lag" model. Shown in the real monthly total for admin
// only, clearly labeled as an unconfirmed estimate — payroll hasn't confirmed the exact
// rule yet, so it's gated by role internally (every call site, including the Salary
// Simulator's own test display, automatically stays correctly scoped without needing
// its own role check).
function computeSeniorityBonusForMonth(monthDate) {
  if ((state.settings.role || "user") !== "admin") return 0;
  if (!currentProductivityBonusEnabled(monthDate)) return 0;
  const refMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() - 2, 1);
  const refPunches = state.punches.filter((p) => sameMonth(new Date(p.clockOutISO), refMonth));
  if (!refPunches.length) return 0;

  let weightedHours = 0;
  for (const p of refPunches) {
    const pb = p.payBreakdown;
    if (!pb || !pb.baseWageILS) continue;
    weightedHours += pb.preBonusPayILS / pb.baseWageILS;
  }
  const currentWage = state.settings.baseWageILS || BASE_WAGE_ILS;
  return round2(0.1 * currentWage * weightedHours);
}

function buildPunch(clockInDate, clockOutDate, shift, pickedShift, shiftType = "") {
  // The +10% seniority bonus is never part of a single shift's own pay — it's a monthly
  // lump sum (see computeSeniorityBonusForMonth), admin-only and still unconfirmed.
  const pay = calculatePay(clockInDate, clockOutDate, {
    idfBonusPercent: state.settings.idfBonusPercent || 0,
    baseWageILS: state.settings.baseWageILS || BASE_WAGE_ILS,
    useUpdatedNightThresholds: usesCorrectedOvertimeModel(),
  });

  const punch = {
    id: uid(),
    date: clockInDate.toISOString().slice(0, 10),
    clockInISO: clockInDate.toISOString(),
    clockOutISO: clockOutDate.toISOString(),
    shiftLabel: `${shift.start}-${shift.end}`,
    shiftType,
    mealPoints: shift.points,
    voucherNote: shift.vouchers,
    actualHours: pay.totalHours,
    payILS: pay.finalPayILS,
    payBreakdown: pay,
    editedFields: [],
  };

  const pointsDelta = shift.points - pickedShift.points;
  return { punch, pay, pointsDelta };
}

async function handleClockOut() {
  const clockOutDate = new Date();
  const clockInDate = new Date(state.currentPunch.clockInISO);
  const pickedShift = state.currentPunch.shift;

  if (clockOutDate.getTime() - clockInDate.getTime() < 60000) {
    openModal("Too soon");
    const p = document.createElement("p");
    p.textContent = "You just clocked in — wait at least a minute before clocking out.";
    modalBody.appendChild(p);
    const okBtn = document.createElement("button");
    okBtn.className = "btn-primary";
    okBtn.textContent = "OK";
    okBtn.addEventListener("click", closeModal);
    modalActions.appendChild(okBtn);
    return;
  }

  const shift = await resolveActualShift(pickedShift, clockOutDate);
  const { punch, pay, pointsDelta } = buildPunch(clockInDate, clockOutDate, shift, pickedShift, state.currentPunch.shiftType);

  state.punches.push(punch);
  state.currentPunch = null;
  saveState();
  renderHome();
  logAnalyticsEvent("clock_out", { hours: punch.actualHours });

  showClockOutSummary(punch, pay, pointsDelta);
}

function showClockOutSummary(punch, pay, pointsDelta) {
  openModal("Shift complete");
  const body = document.createElement("div");

  let adjustmentNote = "";
  if (pointsDelta > 0) {
    adjustmentNote = `<p class="field-hint">⚠️ Shift ran later than planned — Luba points adjusted up by ${pointsDelta}.</p>`;
  } else if (pointsDelta < 0) {
    adjustmentNote = `<p class="field-hint">⚠️ Shift ended earlier than planned — Luba points adjusted down by ${Math.abs(pointsDelta)}.</p>`;
  }

  body.innerHTML = `
    <p><strong>${punch.actualHours}h</strong> worked (${punch.shiftLabel})</p>
    <p>Pay: <strong>${formatILS(punch.payILS)}</strong></p>
    <p>Luba points earned: <strong>${punch.mealPoints}</strong> (${punch.voucherNote})</p>
    ${adjustmentNote}
  `;
  modalBody.appendChild(body);

  const doneBtn = document.createElement("button");
  doneBtn.className = "btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => {
    closeModal();
    if (state.settings.remindPointsOnClockOut) {
      promptLogPointsUsed();
    }
  });
  modalActions.appendChild(doneBtn);
}

function promptLogPointsUsed() {
  openModal("Log Luba points used?");
  const p = document.createElement("p");
  p.textContent = "Did you use Luba points this shift?";
  modalBody.appendChild(p);

  const logBtn = document.createElement("button");
  logBtn.className = "btn-primary";
  logBtn.textContent = "Log now";
  logBtn.addEventListener("click", () => {
    closeModal();
    openLogPointsModal();
  });

  const skipBtn = document.createElement("button");
  skipBtn.className = "btn-plain";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", closeModal);

  modalActions.appendChild(skipBtn);
  modalActions.appendChild(logBtn);
}

// ---------- cafeteria spending ----------

function openLogPointsModal() {
  openModal("Log points used");

  const typeLabel = document.createElement("label");
  typeLabel.className = "field-label";
  typeLabel.textContent = "What was used?";
  const typeSelect = document.createElement("select");
  typeSelect.className = "field-input";
  typeSelect.innerHTML = `
    <option value="100">בשרי (100 נקודות)</option>
    <option value="50">חלבי (50 נקודות)</option>
    <option value="manual">Manual amount</option>
  `;

  const pointsInput = document.createElement("input");
  pointsInput.className = "field-input";
  pointsInput.type = "number";
  pointsInput.min = "0";
  pointsInput.placeholder = "Points spent";
  pointsInput.hidden = true;

  typeSelect.addEventListener("change", () => {
    pointsInput.hidden = typeSelect.value !== "manual";
  });

  const noteInput = document.createElement("input");
  noteInput.className = "field-input";
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";

  modalBody.append(typeLabel, typeSelect, pointsInput, noteInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const pointsSpent = typeSelect.value === "manual" ? parseInt(pointsInput.value, 10) : parseInt(typeSelect.value, 10);
    if (!pointsSpent || pointsSpent <= 0) return;
    const type = typeSelect.value === "100" ? "meat" : typeSelect.value === "50" ? "dairy" : "manual";
    const entry = {
      id: uid(),
      timestampISO: new Date().toISOString(),
      pointsSpent,
      type,
      note: noteInput.value.trim(),
    };
    state.cafeteriaSpending.push(entry);
    saveState();
    closeModal();
    renderHome();
    renderCafeteria();
    logAnalyticsEvent("luba_points_logged", { points: pointsSpent, type });
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.appendChild(cancelBtn);
  modalActions.appendChild(saveBtn);
}

document.getElementById("btn-log-points").addEventListener("click", openLogPointsModal);

// ---------- monthly balance ----------

function monthlyBalance(referenceDate = new Date()) {
  let earned = state.punches
    .filter((p) => sameMonth(new Date(p.clockInISO), referenceDate))
    .reduce((sum, p) => sum + p.mealPoints, 0);

  // Eligibility is decided by the shift picked at clock-in, so an in-progress
  // shift's points count toward the balance immediately, before clock-out.
  if (state.currentPunch && sameMonth(new Date(state.currentPunch.clockInISO), referenceDate)) {
    earned += state.currentPunch.shift.points;
  }

  const spent = state.cafeteriaSpending
    .filter((s) => sameMonth(new Date(s.timestampISO), referenceDate))
    .reduce((sum, s) => sum + s.pointsSpent, 0);
  return { earned, spent, balance: earned - spent };
}

// ---------- render: home ----------

let clockTimerInterval = null;

function updateStatusTimer() {
  if (!state || !state.currentPunch) return;
  const elapsed = Date.now() - new Date(state.currentPunch.clockInISO).getTime();
  document.getElementById("status-timer").textContent = formatElapsed(elapsed);
}

function renderHome() {
  applyTheme();
  const statusLabel = document.getElementById("status-label");
  const statusSub = document.getElementById("status-sub");
  const statusTimer = document.getElementById("status-timer");

  if (state.currentPunch) {
    const clockIn = new Date(state.currentPunch.clockInISO);
    statusLabel.innerHTML = `<span class="status-active-word">Clocked In</span> <span class="status-time-word">since ${formatTime(clockIn)}</span>`;
    statusSub.textContent = `Shift: ${state.currentPunch.shift.start}-${state.currentPunch.shift.end}`;
    clockBtn.textContent = "Clock Out";
    clockBtn.classList.add("is-clockedin");
    statusLabel.classList.remove("is-inactive");
    statusTimer.hidden = false;
    updateStatusTimer();
    if (!clockTimerInterval) clockTimerInterval = setInterval(updateStatusTimer, 1000);
  } else {
    statusLabel.textContent = "Not clocked in";
    statusSub.textContent = "";
    clockBtn.textContent = "Clock In";
    clockBtn.classList.remove("is-clockedin");
    statusLabel.classList.add("is-inactive");
    statusTimer.hidden = true;
    if (clockTimerInterval) {
      clearInterval(clockTimerInterval);
      clockTimerInterval = null;
    }
  }

  const { balance, earned, spent } = monthlyBalance();
  document.getElementById("home-points-balance").textContent = balance;
  document.getElementById("home-points-sub").textContent = `${earned} earned − ${spent} spent this month`;

  const monthStats = computeMoreStats(new Date());
  document.getElementById("home-pay-balance").textContent = formatILS(monthStats.monthPay);
}

document.getElementById("home-pay-card").addEventListener("click", () => {
  const monthStats = computeMoreStats(new Date());
  openMonthlyBreakdownModal(monthStats.monthPunches, new Date());
});

// ---------- render: history (Monthly Attendance) ----------

let historyViewedMonth = new Date();

function renderHistory() {
  const isCurrentMonth = sameMonth(historyViewedMonth, new Date());
  document.getElementById("history-month-label").textContent =
    historyViewedMonth.toLocaleDateString([], { year: "numeric", month: "long" });
  document.getElementById("history-next-month").disabled = isCurrentMonth;

  const showShiftType = !!state.settings.trackShiftType;
  document.getElementById("history-th-shifttype").hidden = !showShiftType;
  const colCount = showShiftType ? 5 : 4;

  const tbody = document.getElementById("history-table-body");
  tbody.innerHTML = "";

  const monthPunches = state.punches.filter((p) => sameMonth(new Date(p.clockInISO), historyViewedMonth));
  const sorted = [...monthPunches].sort((a, b) => new Date(a.clockInISO) - new Date(b.clockInISO));

  const totalHours = monthPunches.reduce((sum, p) => sum + p.actualHours, 0);
  document.getElementById("history-total-hours").textContent = `Total: ${totalHours.toFixed(1)} Hours`;

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="list-empty">No shifts logged this month</td></tr>`;
    return;
  }

  for (const p of sorted) {
    const tr = document.createElement("tr");
    tr.dataset.punchId = p.id;
    const edited = p.editedFields || [];
    const inCellClass = edited.includes("clockIn") ? "cell-edited" : "";
    const outCellClass = edited.includes("clockOut") ? "cell-edited" : "";
    const clockInDate = new Date(p.clockInISO);
    const clockOutDate = new Date(p.clockOutISO);
    const outSuffix = sameDay(clockInDate, clockOutDate) ? "" : " (+1)";
    tr.innerHTML = `
      <td>${formatDate(clockInDate)}</td>
      ${showShiftType ? `<td>${p.shiftType || "—"}</td>` : ""}
      <td class="${inCellClass}">${formatTime(clockInDate)}</td>
      <td class="${outCellClass}">${formatTime(clockOutDate)}${outSuffix}</td>
      <td>${p.actualHours}h</td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById("history-table-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-punch-id]");
  if (!tr) return;
  const punch = state.punches.find((p) => p.id === tr.dataset.punchId);
  if (punch) openEditPunchModal(punch);
});

document.getElementById("history-prev-month").addEventListener("click", () => {
  historyViewedMonth = new Date(historyViewedMonth.getFullYear(), historyViewedMonth.getMonth() - 1, 1);
  renderHistory();
});

document.getElementById("history-next-month").addEventListener("click", () => {
  if (sameMonth(historyViewedMonth, new Date())) return;
  historyViewedMonth = new Date(historyViewedMonth.getFullYear(), historyViewedMonth.getMonth() + 1, 1);
  renderHistory();
});

// ---------- render: cafeteria ----------

let cafeteriaViewedMonth = new Date();

// Builds one chronological feed mixing real spending log entries (editable) with
// read-only "earned" entries derived from each completed shift's Luba points —
// shifts aren't logged as cafeteria entries, so there's nothing to edit there;
// editing what a shift earned means editing the shift itself, in Attendance.
function buildCafeteriaFeed(referenceDate) {
  const earnedEntries = state.punches
    .filter((p) => p.mealPoints > 0 && sameMonth(new Date(p.clockOutISO), referenceDate))
    .map((p) => ({
      kind: "earned",
      timestampISO: p.clockOutISO,
      points: p.mealPoints,
      note: p.shiftLabel,
    }));

  const spentEntries = state.cafeteriaSpending
    .filter((s) => sameMonth(new Date(s.timestampISO), referenceDate))
    .map((s) => ({
      kind: "spent",
      timestampISO: s.timestampISO,
      points: s.pointsSpent,
      note: s.note,
      raw: s,
    }));

  return [...earnedEntries, ...spentEntries].sort((a, b) => new Date(b.timestampISO) - new Date(a.timestampISO));
}

function renderCafeteria() {
  const isCurrentMonth = sameMonth(cafeteriaViewedMonth, new Date());
  document.getElementById("cafeteria-month-label").textContent =
    cafeteriaViewedMonth.toLocaleDateString([], { year: "numeric", month: "long" });
  document.getElementById("cafeteria-next-month").disabled = isCurrentMonth;

  const { balance, earned, spent } = monthlyBalance(cafeteriaViewedMonth);
  document.getElementById("cafeteria-balance").textContent = balance;
  document.getElementById("cafeteria-balance-sub").textContent = `${earned} earned − ${spent} spent (resets next month)`;

  const list = document.getElementById("cafeteria-list");
  list.innerHTML = "";
  const feed = buildCafeteriaFeed(cafeteriaViewedMonth);

  if (!feed.length) {
    list.innerHTML = `<li class="list-empty">No Luba activity this month</li>`;
    return;
  }

  // Built with textContent rather than innerHTML: entry.note is a free-text field the
  // user typed themselves and could contain HTML — reading it back through innerHTML
  // would execute it, so even though this is currently only ever shown back to its
  // own author, it's not a safe pattern to leave in place.
  for (const entry of feed) {
    const li = document.createElement("li");
    li.className = "list-item";
    const d = new Date(entry.timestampISO);
    const sign = entry.kind === "earned" ? "+" : "-";
    const colorClass = entry.kind === "earned" ? "pts-earned" : "pts-spent";

    const row = document.createElement("div");
    row.className = "list-item-row";
    const dateSpan = document.createElement("span");
    dateSpan.textContent = `${formatDate(d)} ${formatTime(d)}`;
    const ptsSpan = document.createElement("span");
    ptsSpan.className = colorClass;
    ptsSpan.textContent = `${entry.kind} ${sign}${entry.points} pts`;
    row.append(dateSpan, ptsSpan);
    li.appendChild(row);

    if (entry.note) {
      const noteP = document.createElement("p");
      noteP.className = "list-item-sub";
      noteP.textContent = entry.note;
      li.appendChild(noteP);
    }

    if (entry.kind === "spent") {
      li.classList.add("is-clickable");
      li.addEventListener("click", () => openEditSpendingModal(entry.raw));
    }
    list.appendChild(li);
  }
}

document.getElementById("cafeteria-prev-month").addEventListener("click", () => {
  cafeteriaViewedMonth = new Date(cafeteriaViewedMonth.getFullYear(), cafeteriaViewedMonth.getMonth() - 1, 1);
  renderCafeteria();
});

document.getElementById("cafeteria-next-month").addEventListener("click", () => {
  if (sameMonth(cafeteriaViewedMonth, new Date())) return;
  cafeteriaViewedMonth = new Date(cafeteriaViewedMonth.getFullYear(), cafeteriaViewedMonth.getMonth() + 1, 1);
  renderCafeteria();
});

function openEditSpendingModal(entry) {
  openModal("Edit Luba points used");

  const typeLabel = document.createElement("label");
  typeLabel.className = "field-label";
  typeLabel.textContent = "What was used?";
  const typeSelect = document.createElement("select");
  typeSelect.className = "field-input";
  typeSelect.innerHTML = `
    <option value="100">בשרי (100 נקודות)</option>
    <option value="50">חלבי (50 נקודות)</option>
    <option value="manual">Manual amount</option>
  `;
  typeSelect.value = entry.type === "meat" ? "100" : entry.type === "dairy" ? "50" : "manual";

  const pointsInput = document.createElement("input");
  pointsInput.className = "field-input";
  pointsInput.type = "number";
  pointsInput.min = "0";
  pointsInput.placeholder = "Points spent";
  pointsInput.value = entry.pointsSpent;
  pointsInput.hidden = typeSelect.value !== "manual";

  typeSelect.addEventListener("change", () => {
    pointsInput.hidden = typeSelect.value !== "manual";
  });

  const noteInput = document.createElement("input");
  noteInput.className = "field-input";
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";
  noteInput.value = entry.note || "";

  modalBody.append(typeLabel, typeSelect, pointsInput, noteInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const pointsSpent = typeSelect.value === "manual" ? parseInt(pointsInput.value, 10) : parseInt(typeSelect.value, 10);
    if (!pointsSpent || pointsSpent <= 0) return;
    entry.pointsSpent = pointsSpent;
    entry.type = typeSelect.value === "100" ? "meat" : typeSelect.value === "50" ? "dairy" : "manual";
    entry.note = noteInput.value.trim();
    saveState();
    closeModal();
    renderHome();
    renderCafeteria();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    state.cafeteriaSpending = state.cafeteriaSpending.filter((s) => s.id !== entry.id);
    saveState();
    closeModal();
    renderHome();
    renderCafeteria();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(deleteBtn, cancelBtn, saveBtn);
}

// ---------- render: who's on clock ----------

// "Has this user shared their own schedule for the current week?" is derived
// straight from their shifts rather than a stored week-key: a paste always
// replaces the whole array, so once none of it falls in the current week
// anymore, this naturally (and correctly) re-locks them without any extra
// state to keep in sync.
function hasSharedCurrentWeek(shifts, now = new Date()) {
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
  return (shifts || []).some((s) => {
    const d = new Date(s.dateISO);
    return d >= weekStart && d < weekEnd;
  });
}

let whosOnClockFilterMode = "in"; // "in" = everyone active/upcoming, "with" = only colleagues overlapping my own shift

function shiftsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function renderWhosOnClock() {
  const lockedCard = document.getElementById("whosonclock-locked");
  const content = document.getElementById("whosonclock-content");
  const mine = colleagueSchedules.find((s) => s.uid === currentUid);

  if (!mine || !hasSharedCurrentWeek(mine.shifts)) {
    lockedCard.hidden = false;
    content.hidden = true;
    return;
  }
  lockedCard.hidden = true;
  content.hidden = false;

  const now = new Date();
  const twoHoursFromNow = new Date(now.getTime() + 2 * 3600000);
  const myShiftIntervals = (mine.shifts || []).map((s) => ({ start: new Date(s.startISO), end: new Date(s.endISO) }));
  const myActiveShift = myShiftIntervals.find((s) => s.start <= now && now < s.end);

  let activeNow = [];
  let comingUp = [];
  for (const colleague of colleagueSchedules) {
    if (colleague.uid === currentUid) continue;
    if (colleague.active === false) continue; // deactivated by an admin — hide immediately
    for (const shift of colleague.shifts || []) {
      const start = new Date(shift.startISO);
      const end = new Date(shift.endISO);
      if (start <= now && now < end) {
        activeNow.push({ colleague, shift, start, end });
      } else if (now < start && start <= twoHoursFromNow) {
        comingUp.push({ colleague, shift, start, end });
      }
    }
  }

  if (whosOnClockFilterMode === "with") {
    const overlapsMine = (start, end) => myShiftIntervals.some((m) => shiftsOverlap(start, end, m.start, m.end));
    activeNow = activeNow.filter(({ start, end }) => overlapsMine(start, end));
    comingUp = comingUp.filter(({ start, end }) => overlapsMine(start, end));
  }

  activeNow.sort((a, b) => a.start - b.start);
  comingUp.sort((a, b) => a.start - b.start);

  const activeList = document.getElementById("woc-active-list");
  const upcomingList = document.getElementById("woc-upcoming-list");
  const divider = document.getElementById("woc-divider");
  activeList.innerHTML = "";
  upcomingList.innerHTML = "";

  if (!activeNow.length && !comingUp.length) {
    activeList.innerHTML = whosOnClockFilterMode === "with"
      ? `<li class="list-empty">No colleagues overlap with your shift right now</li>`
      : `<li class="list-empty">No colleagues on clock right now</li>`;
  }

  // Built with textContent/createElement rather than innerHTML: colleague.displayName
  // and shift.role both come from another user's own Firestore schedule doc (their
  // Settings name fields / a pasted-SMS free-text tail), so they're attacker-controlled
  // data — interpolating them into innerHTML would be a stored-XSS hole letting any
  // signed-in colleague run script in everyone else's session just by typing HTML into
  // their own name or shift-role text.
  for (const { colleague, shift, start, end } of activeNow) {
    const li = document.createElement("li");
    li.className = "list-item woc-card woc-active";

    const nameDiv = document.createElement("div");
    nameDiv.className = "woc-name";
    const dot = document.createElement("span");
    dot.className = "woc-dot";
    nameDiv.appendChild(dot);
    nameDiv.appendChild(document.createTextNode(colleague.displayName));
    if (myActiveShift) {
      const withYouTag = document.createElement("span");
      withYouTag.className = "woc-tag";
      withYouTag.textContent = "· with you";
      nameDiv.appendChild(withYouTag);
    }

    const subP = document.createElement("p");
    subP.className = "list-item-sub";
    subP.textContent = `${formatTime(start)} - ${formatTime(end)}${shift.role ? ` · ${shift.role}` : ""}`;

    li.append(nameDiv, subP);
    activeList.appendChild(li);
  }

  divider.hidden = !comingUp.length;
  for (const { colleague, shift, start, end } of comingUp) {
    const li = document.createElement("li");
    li.className = "list-item woc-card woc-upcoming";

    const nameDiv = document.createElement("div");
    nameDiv.className = "woc-name";
    nameDiv.textContent = colleague.displayName;

    const subP = document.createElement("p");
    subP.className = "list-item-sub";
    subP.textContent = `${formatTime(start)} - ${formatTime(end)}${shift.role ? ` · ${shift.role}` : ""}`;

    li.append(nameDiv, subP);
    upcomingList.appendChild(li);
  }
}

document.querySelectorAll("#woc-filter-segmented .segmented-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    whosOnClockFilterMode = btn.dataset.value;
    document.querySelectorAll("#woc-filter-segmented .segmented-option").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    renderWhosOnClock();
  });
});

// Keeps Active Now / Coming Up fresh purely from the passage of time (no
// Firestore write involved), mirroring the home screen's elapsed-time ticker.
setInterval(() => {
  if (!document.getElementById("screen-whosonclock").hidden) renderWhosOnClock();
}, 60000);

// Shared by the "currently saved" list and the paste-preview list below — built with
// textContent rather than innerHTML since `role` is free text (typed in Settings, or
// the tail of a pasted SMS line) and must never be interpreted as HTML.
function buildShiftListItem(dateLabel, timeLabel, role) {
  const li = document.createElement("li");
  li.className = "list-item";

  const row = document.createElement("div");
  row.className = "list-item-row";
  const dateSpan = document.createElement("span");
  dateSpan.textContent = dateLabel;
  const timeSpan = document.createElement("span");
  timeSpan.textContent = timeLabel;
  row.append(dateSpan, timeSpan);
  li.appendChild(row);

  if (role) {
    const roleP = document.createElement("p");
    roleP.className = "list-item-sub";
    roleP.textContent = role;
    li.appendChild(roleP);
  }
  return li;
}

function openUpdateScheduleModal() {
  openModal("Update your schedule");

  if (!state.settings.firstName || !state.settings.lastName || !state.settings.department) {
    const p = document.createElement("p");
    p.className = "field-error";
    p.textContent = "Please fill in your first name, last name, and department in Settings > Personal Info first.";
    modalBody.appendChild(p);
    const okBtn = document.createElement("button");
    okBtn.className = "btn-primary";
    okBtn.textContent = "OK";
    okBtn.addEventListener("click", closeModal);
    modalActions.appendChild(okBtn);
    return;
  }

  const mine = colleagueSchedules.find((s) => s.uid === currentUid);
  if (mine && mine.shifts && mine.shifts.length) {
    const lastDate = mine.shifts.reduce((max, s) => (s.dateISO > max ? s.dateISO : max), mine.shifts[0].dateISO);
    const currentTitle = document.createElement("p");
    currentTitle.className = "card-title";
    currentTitle.textContent = `Currently saved: ${mine.shifts.length} shift(s), through ${lastDate}`;
    const currentList = document.createElement("ul");
    currentList.className = "list";
    mine.shifts.forEach((s, index) => {
      const li = buildShiftListItem(s.dateISO, `${formatTime(new Date(s.startISO))} - ${formatTime(new Date(s.endISO))}`, s.role);
      li.classList.add("is-clickable");
      li.addEventListener("click", () => {
        closeModal();
        openEditScheduleShiftModal(index);
      });
      currentList.appendChild(li);
    });
    modalBody.append(currentTitle, currentList);
  }

  const hint = document.createElement("p");
  hint.className = "field-hint";
  hint.textContent = "Paste the weekly shift SMS you received below to update it.";

  const textarea = document.createElement("textarea");
  textarea.className = "field-input";
  textarea.dir = "rtl";
  textarea.rows = 8;
  textarea.placeholder = "פורסם סידור עבודה במשמרות.קום! שיבוציך:\n2.8 א' - 10:00-18:00 מלווה נוסעים\n...";

  const warning = document.createElement("p");
  warning.className = "field-hint";

  const preview = document.createElement("ul");
  preview.className = "list";

  modalBody.append(hint, textarea, warning, preview);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.disabled = true;

  let parsedShifts = [];

  textarea.addEventListener("input", () => {
    const { shifts, skippedLines } = parseScheduleSms(textarea.value);
    parsedShifts = shifts;
    saveBtn.disabled = shifts.length === 0;

    const pastedSomething = textarea.value.trim().length > 0;
    if (pastedSomething && shifts.length === 0) {
      warning.className = "field-error";
      warning.textContent = "Couldn't recognize this format — check that you pasted the full SMS text without changes.";
    } else if (skippedLines.length) {
      warning.className = "field-hint";
      warning.textContent = `${skippedLines.length} line(s) couldn't be read and will be ignored.`;
    } else {
      warning.className = "field-hint";
      warning.textContent = "";
    }

    preview.innerHTML = "";
    for (const s of shifts) {
      const li = buildShiftListItem(s.dateISO, `${formatTime(new Date(s.startISO))} - ${formatTime(new Date(s.endISO))}`, s.role);
      preview.appendChild(li);
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!parsedShifts.length) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const displayName = `${state.settings.firstName} ${state.settings.lastName}`.trim();
      await saveMySchedule(currentUid, {
        displayName,
        department: state.settings.department,
        shifts: parsedShifts,
      });
      renderWhosOnClock();
      logAnalyticsEvent("schedule_shared", { shift_count: parsedShifts.length });
      showScheduleSavedConfirmation(parsedShifts);
    } catch (err) {
      console.error("schedule save failed:", err);
      warning.textContent = "Couldn't save — check your connection and try again.";
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(cancelBtn, saveBtn);
}

// Persists an edited/trimmed copy of the current user's own saved shift list —
// saveMySchedule always replaces the whole array, so every caller here reads
// colleagueSchedules fresh (not a captured/stale copy) and writes back the full set.
async function persistMyShifts(updatedShifts) {
  await saveMySchedule(currentUid, {
    displayName: `${state.settings.firstName} ${state.settings.lastName}`.trim(),
    department: state.settings.department,
    shifts: updatedShifts,
  });
  renderWhosOnClock();
}

// Edit or remove one shift from the current user's own saved schedule (reached from
// the "Update your schedule" list on Who's In) — a permanent app feature, not tour-only.
// Sync (save + re-render) only happens after Save or after confirming removal.
function openEditScheduleShiftModal(index) {
  const mine = colleagueSchedules.find((s) => s.uid === currentUid);
  const shift = mine.shifts[index];

  openModal("Edit shift");

  if (shift.role) {
    const roleP = document.createElement("p");
    roleP.className = "list-item-sub";
    roleP.textContent = shift.role;
    modalBody.appendChild(roleP);
  }

  const inFields = createDateTimeFields("Start", new Date(shift.startISO));
  const outFields = createDateTimeFields("End", new Date(shift.endISO));

  const errorP = document.createElement("p");
  errorP.className = "field-hint";

  modalBody.append(inFields.label, inFields.dateInput, inFields.timeInput, outFields.label, outFields.dateInput, outFields.timeInput, errorP);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const startDate = parseDateTimeFields(inFields.dateInput, inFields.timeInput);
    const endDate = parseDateTimeFields(outFields.dateInput, outFields.timeInput);
    if (!startDate || !endDate) {
      errorP.textContent = "Enter both start and end as a valid date and time (HH:MM).";
      return;
    }
    if (endDate <= startDate) {
      errorP.textContent = "End must be after start.";
      return;
    }

    const pad = (n) => String(n).padStart(2, "0");
    const latest = colleagueSchedules.find((s) => s.uid === currentUid);
    const updatedShifts = [...latest.shifts];
    updatedShifts[index] = {
      ...updatedShifts[index],
      dateISO: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
      startISO: startDate.toISOString(),
      endISO: endDate.toISOString(),
    };
    closeModal();
    try {
      await persistMyShifts(updatedShifts);
    } catch (err) {
      console.error("schedule shift update failed:", err);
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-danger";
  deleteBtn.textContent = "Remove shift";
  deleteBtn.addEventListener("click", () => {
    closeModal();
    openModal("Remove this shift?");
    const p = document.createElement("p");
    p.textContent = `Remove the ${formatTime(new Date(shift.startISO))} - ${formatTime(new Date(shift.endISO))} shift on ${shift.dateISO}? This can't be undone.`;
    modalBody.appendChild(p);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-danger";
    confirmBtn.textContent = "Remove shift";
    confirmBtn.addEventListener("click", async () => {
      const latest = colleagueSchedules.find((s) => s.uid === currentUid);
      const updatedShifts = latest.shifts.filter((_, i) => i !== index);
      closeModal();
      try {
        await persistMyShifts(updatedShifts);
      } catch (err) {
        console.error("schedule shift removal failed:", err);
      }
    });

    const cancelConfirmBtn = document.createElement("button");
    cancelConfirmBtn.className = "btn-plain";
    cancelConfirmBtn.textContent = "Cancel";
    cancelConfirmBtn.addEventListener("click", closeModal);

    modalActions.append(cancelConfirmBtn, confirmBtn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(cancelBtn, deleteBtn, saveBtn);
}

function showScheduleSavedConfirmation(shifts) {
  const lastDate = shifts.reduce((max, s) => (s.dateISO > max ? s.dateISO : max), shifts[0].dateISO);
  openModal("Schedule updated");
  const p = document.createElement("p");
  p.className = "card-title";
  p.textContent = `✓ Saved ${shifts.length} shift(s), through ${lastDate}`;
  modalBody.appendChild(p);
  const doneBtn = document.createElement("button");
  doneBtn.className = "btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", closeModal);
  modalActions.appendChild(doneBtn);
}

document.getElementById("btn-update-schedule").addEventListener("click", () => {
  maybeShowShareConsentScreen(openUpdateScheduleModal);
});

const APP_URL = "https://mennykaufman.github.io/punch-clock/";
const APP_LOGO_URL = `${APP_URL}icons/icon-192.png`;

function inviteShareText() {
  return `TrackO'clock – האפליקציה של מני שמחברת את העובדים ומנגישה הכל! 🤝\nכנס/י לראות מי איתך במשמרת וכמה נקודות נשארו לך בלובה: ${APP_URL}`;
}

function openInviteModal() {
  openModal("Invite friends");

  const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(APP_URL)}&centerImageUrl=${encodeURIComponent(APP_LOGO_URL)}&centerImageSizeRatio=0.25&ecLevel=H&size=260&margin=1`;
  const img = document.createElement("img");
  img.src = qrUrl;
  img.alt = "QR code linking to TrackO'clock";
  img.style.cssText = "width:100%;max-width:260px;display:block;margin:0 auto 12px;border-radius:12px;";

  const linkP = document.createElement("p");
  linkP.className = "field-hint";
  linkP.style.cssText = "text-align:center;word-break:break-all;";
  linkP.textContent = APP_URL;

  modalBody.append(img, linkP);

  const shareBtn = document.createElement("button");
  shareBtn.className = "btn-primary";
  const canNativeShare = typeof navigator.share === "function";
  shareBtn.textContent = canNativeShare ? "Share" : "Copy link";
  shareBtn.addEventListener("click", async () => {
    if (canNativeShare) {
      try {
        await navigator.share({ title: "TrackO'clock", text: inviteShareText() });
      } catch (err) {
        // User closed the native share sheet without picking anything — not an error.
      }
    } else {
      try {
        await navigator.clipboard.writeText(inviteShareText());
        shareBtn.textContent = "Copied ✓";
        setTimeout(() => { shareBtn.textContent = "Copy link"; }, 1500);
      } catch (err) {
        console.error("clipboard write failed:", err);
      }
    }
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-plain";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);

  modalActions.append(closeBtn, shareBtn);
}

document.getElementById("btn-invite-friends").addEventListener("click", openInviteModal);

// ---------- render: settings ----------

function applyTheme() {
  const theme = state?.settings?.theme || "system";
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

// The floating save bar starts hidden and only appears once the user actually
// touches a field — it isn't part of renderSettings() itself since several
// field handlers below call renderSettings() to refresh a derived hint right
// after marking things dirty, and that must not immediately hide the bar again.
function markSettingsDirty() {
  document.getElementById("settings-save-bar").hidden = false;
}

function hideSettingsSaveBar() {
  document.getElementById("settings-save-bar").hidden = true;
}

function renderSettings() {
  document.getElementById("settings-first-name").value = state.settings.firstName || "";
  document.getElementById("settings-last-name").value = state.settings.lastName || "";
  document.getElementById("settings-department").value = state.settings.department || "";
  document.getElementById("settings-base-wage").value = state.settings.baseWageILS || BASE_WAGE_ILS;
  document.getElementById("remind-points-toggle").checked = !!state.settings.remindPointsOnClockOut;
  document.getElementById("track-shift-type-toggle").checked = !!state.settings.trackShiftType;
  document.getElementById("theme-select").value = state.settings.theme || "system";
  document.getElementById("monthly-hours-goal").value = state.settings.monthlyHoursGoal || "";
  document.getElementById("signed-in-as").textContent = currentUid ? `Signed in as: ${currentUserLabel}` : "";

  const isAdmin = (state.settings.role || "user") === "admin";
  document.getElementById("btn-open-admin-dashboard").hidden = !isAdmin;

  document.getElementById("settings-employment-start-date").value = state.settings.employmentStartDate || "";

  const idfPercent = state.settings.idfBonusPercent || 0;
  document.querySelectorAll("#idf-bonus-segmented .segmented-option").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.value) === idfPercent);
  });

  const seniorityEnabled = currentProductivityBonusEnabled();
  document.getElementById("settings-seniority-toggle").checked = seniorityEnabled;

  const hint = document.getElementById("settings-bonus-hint");
  const isOverridden = state.settings.productivityBonusOverride === true || state.settings.productivityBonusOverride === false;
  if (isOverridden) {
    hint.textContent = `Manually ${seniorityEnabled ? "enabled" : "disabled"} (overriding the 3-month rule).`;
  } else if (!state.settings.employmentStartDate) {
    hint.textContent = "Set your start date to auto-apply the 10% seniority bonus after 3 months.";
  } else {
    hint.textContent = seniorityEnabled
      ? "Eligible for the 10% seniority bonus ✓"
      : "Not yet eligible — applies automatically 3 months after your start date.";
  }

  const widgets = state.settings.moreWidgets || {};
  for (const key of ["hours", "shifts", "pay", "averages", "luba", "export"]) {
    document.getElementById(`more-widget-${key}`).checked = widgets[key] !== false;
  }
}

for (const key of ["hours", "shifts", "pay", "averages", "luba", "export"]) {
  document.getElementById(`more-widget-${key}`).addEventListener("change", (e) => {
    if (!state.settings.moreWidgets) state.settings.moreWidgets = {};
    state.settings.moreWidgets[key] = e.target.checked;
    markSettingsDirty();
  });
}

document.getElementById("settings-first-name").addEventListener("change", (e) => {
  state.settings.firstName = e.target.value.trim();
  markSettingsDirty();
});

document.getElementById("settings-last-name").addEventListener("change", (e) => {
  state.settings.lastName = e.target.value.trim();
  markSettingsDirty();
});

document.getElementById("settings-department").addEventListener("change", (e) => {
  state.settings.department = e.target.value;
  startDeptScheduleSync(state.settings.department);
  markSettingsDirty();
});

document.getElementById("settings-base-wage").addEventListener("change", (e) => {
  const value = Number(e.target.value);
  state.settings.baseWageILS = value > 0 ? value : BASE_WAGE_ILS;
  renderSettings();
  markSettingsDirty();
});

document.getElementById("settings-employment-start-date").addEventListener("change", (e) => {
  state.settings.employmentStartDate = e.target.value;
  renderSettings();
  markSettingsDirty();
});

document.querySelectorAll("#idf-bonus-segmented .segmented-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.settings.idfBonusPercent = Number(btn.dataset.value);
    renderSettings();
    markSettingsDirty();
  });
});

document.getElementById("settings-seniority-toggle").addEventListener("change", (e) => {
  state.settings.productivityBonusOverride = e.target.checked;
  renderSettings();
  markSettingsDirty();
});

document.getElementById("monthly-hours-goal").addEventListener("change", (e) => {
  state.settings.monthlyHoursGoal = Number(e.target.value) || 0;
  markSettingsDirty();
});

document.getElementById("remind-points-toggle").addEventListener("change", (e) => {
  state.settings.remindPointsOnClockOut = e.target.checked;
  markSettingsDirty();
});

document.getElementById("track-shift-type-toggle").addEventListener("change", (e) => {
  state.settings.trackShiftType = e.target.checked;
  renderHistory();
  markSettingsDirty();
});

document.getElementById("theme-select").addEventListener("change", (e) => {
  state.settings.theme = e.target.value;
  applyTheme();
  markSettingsDirty();
});

// One global save for the whole Settings screen — every field above only
// mutates `state` in memory (for live feedback like hints/theme), and this
// button is what actually persists it, instead of each section silently
// saving itself the moment you touch it.
document.getElementById("btn-save-all-settings").addEventListener("click", () => {
  saveState();
  hideSettingsSaveBar();
  const hint = document.getElementById("settings-saved-hint");
  hint.textContent = "Saved ✓";
  setTimeout(() => { hint.textContent = ""; }, 2000);
});

document.getElementById("btn-logout").addEventListener("click", handleLogout);

document.getElementById("btn-delete-account").addEventListener("click", openDeleteAccountModal);

document.getElementById("btn-open-admin-dashboard").addEventListener("click", () => openAdminDashboardModal());

function openDeleteAccountModal() {
  openModal("Delete your account?");
  const p = document.createElement("p");
  p.textContent = "This permanently deletes your account and all your data (shifts, Luba points, settings) from our servers. This can't be undone.";
  modalBody.appendChild(p);
  const errorP = document.createElement("p");
  errorP.className = "field-hint";
  modalBody.appendChild(errorP);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn-danger";
  confirmBtn.textContent = "Delete permanently";
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting…";
    try {
      const uidToDelete = currentUid;
      await deleteUserAccount(uidToDelete);
      localStorage.removeItem(localCacheKey(uidToDelete));
      if (unsubscribeCloud) unsubscribeCloud();
      unsubscribeCloud = null;
      if (unsubscribeDeptSchedules) unsubscribeDeptSchedules();
      unsubscribeDeptSchedules = null;
      colleagueSchedules = [];
      deptSyncedFor = null;
      if (clockTimerInterval) {
        clearInterval(clockTimerInterval);
        clockTimerInterval = null;
      }
      currentUid = null;
      currentUserLabel = "";
      state = null;
      closeModal();
      showLoginScreen();
    } catch (err) {
      console.error("account deletion failed:", err);
      errorP.textContent = err?.code === "auth/requires-recent-login"
        ? "For security, please log out and sign back in, then try deleting your account again."
        : "Couldn't delete your account — check your connection and try again.";
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete permanently";
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(cancelBtn, confirmBtn);
}

// ---------- "More": monthly summary + manual shift entry ----------

// Native <input type="time">/"datetime-local"> widgets render 12h/24h per the BROWSER's
// own locale, which can silently ignore the device's "24-hour clock" system setting
// (a known quirk, especially on mobile Safari) — so every shift-editing time field uses
// a plain 24h "HH:MM" text input instead, paired with a separate <input type="date">.
const TIME_24H_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function formatDateInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimeInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// inputMode="numeric" gives mobile users a digits-only keypad with no ":" key, so without
// this they can never actually type a string matching TIME_24H_RE — the field silently
// can't be filled in correctly and every save fails validation. Auto-inserting the colon
// after the 2nd digit (and stripping any non-digits first, so a pasted "12:34" still works)
// means the user only ever has to type digits.
function attachTimeInputMask(input) {
  input.addEventListener("input", () => {
    // Preserve cursor position across the rewrite below (by distance from the end,
    // not absolute index) — otherwise editing a digit in the middle of an existing
    // time (not just typing a fresh one left-to-right) knocks the cursor to the end
    // after every keystroke.
    const cursorFromEnd = input.value.length - input.selectionStart;
    const digits = input.value.replace(/\D/g, "").slice(0, 4);
    input.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    const pos = Math.max(0, input.value.length - cursorFromEnd);
    input.setSelectionRange(pos, pos);
  });
}

// Builds a labeled [date input, 24h time-text input] pair, pre-filled from initialDate
// if given. Returns the pieces the caller needs to append to the modal and to read back.
function createDateTimeFields(labelText, initialDate) {
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = labelText;

  const dateInput = document.createElement("input");
  dateInput.className = "field-input";
  dateInput.type = "date";

  const timeInput = document.createElement("input");
  timeInput.className = "field-input";
  timeInput.type = "text";
  timeInput.placeholder = "HH:MM (24h)";
  timeInput.inputMode = "numeric";
  timeInput.maxLength = 5;
  attachTimeInputMask(timeInput);

  if (initialDate) {
    dateInput.value = formatDateInputValue(initialDate);
    timeInput.value = formatTimeInputValue(initialDate);
  }

  return { label, dateInput, timeInput };
}

// Returns a real Date built from the pair, or null if either field is empty/invalid —
// callers show their own "enter both..." message rather than this throwing.
function parseDateTimeFields(dateInput, timeInput) {
  if (!dateInput.value || !TIME_24H_RE.test(timeInput.value)) return null;
  const [y, mo, d] = dateInput.value.split("-").map(Number);
  const [h, m] = timeInput.value.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m);
}

function computeMoreStats(referenceDate = new Date()) {
  // Week stats are always relative to the real current week, regardless of which
  // month is being browsed — they're only ever shown alongside the current month anyway.
  const weekStart = startOfWeek(new Date());
  const weekPunches = state.punches.filter((p) => new Date(p.clockInISO) >= weekStart);
  const monthPunches = state.punches.filter((p) => sameMonth(new Date(p.clockInISO), referenceDate));
  const sum = (arr, key) => arr.reduce((s, p) => s + p[key], 0);

  const weekHours = sum(weekPunches, "actualHours");
  const weekPay = sum(weekPunches, "payILS");
  const monthHours = sum(monthPunches, "actualHours");
  // Admin-only estimate — see computeSeniorityBonusForMonth (returns 0 for everyone else).
  const seniorityBonus = computeSeniorityBonusForMonth(referenceDate);
  const monthPay = sum(monthPunches, "payILS") + seniorityBonus;
  const monthShiftCount = monthPunches.length;

  const monthSpending = state.cafeteriaSpending.filter((s) => sameMonth(new Date(s.timestampISO), referenceDate));
  const spentByType = { meat: 0, dairy: 0, manual: 0 };
  const countByType = { meat: 0, dairy: 0, manual: 0 };
  for (const s of monthSpending) {
    const t = s.type || "manual";
    spentByType[t] += s.pointsSpent;
    countByType[t] += 1;
  }
  const { earned, spent, balance } = monthlyBalance(referenceDate);

  return {
    weekHours, weekPay, monthHours, monthPay, monthShiftCount, monthPunches, seniorityBonus,
    avgHoursPerShift: monthShiftCount ? monthHours / monthShiftCount : 0,
    avgPayPerShift: monthShiftCount ? monthPay / monthShiftCount : 0,
    avgHourlyPay: monthHours ? monthPay / monthHours : 0,
    lubaEarned: earned, lubaSpent: spent, lubaBalance: balance,
    spentByType, countByType,
  };
}

// ---------- monthly attendance export (Excel / PDF) ----------

function monthExportRows(monthPunches) {
  const sorted = [...monthPunches].sort((a, b) => new Date(a.clockInISO) - new Date(b.clockInISO));
  return sorted.map((p) => ({
    Date: formatDate(new Date(p.clockInISO)),
    In: formatTime(new Date(p.clockInISO)),
    Out: `${formatDate(new Date(p.clockOutISO))} ${formatTime(new Date(p.clockOutISO))}`,
    Hours: p.actualHours,
    Pay: p.payILS,
    Points: p.mealPoints,
  }));
}

function exportMonthToXlsx(monthPunches, monthDate) {
  if (typeof XLSX === "undefined") {
    alert("Export library didn't load — check your internet connection and try again.");
    return;
  }
  const rows = monthExportRows(monthPunches);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Attendance");
  const monthName = monthDate.toLocaleDateString([], { year: "numeric", month: "2-digit" });
  XLSX.writeFile(workbook, `attendance-${monthName}.xlsx`);
  logAnalyticsEvent("export_data", { format: "xlsx" });
}

function exportMonthToPdf(monthPunches, monthDate) {
  if (typeof window.jspdf === "undefined") {
    alert("Export library didn't load — check your internet connection and try again.");
    return;
  }
  const rows = monthExportRows(monthPunches);
  const doc = new window.jspdf.jsPDF();
  doc.text("Monthly Attendance", 14, 14);
  doc.autoTable({
    startY: 20,
    head: [["Date", "In", "Out", "Hours", "Pay", "Points"]],
    body: rows.map((r) => [r.Date, r.In, r.Out, r.Hours, formatILS(r.Pay), r.Points]),
  });
  const monthName = monthDate.toLocaleDateString([], { year: "numeric", month: "2-digit" });
  doc.save(`attendance-${monthName}.pdf`);
  logAnalyticsEvent("export_data", { format: "pdf" });
}

// The month shown here always matches whatever month is currently browsed on the
// Monthly Attendance screen (historyViewedMonth) — navigating months happens there,
// not in this modal, so the two never drift out of sync.
function openMoreModal() {
  openModal("More");

  const isCurrentMonth = sameMonth(historyViewedMonth, new Date());
  const s = computeMoreStats(historyViewedMonth);
  const goal = state.settings.monthlyHoursGoal || 0;
  const widgets = state.settings.moreWidgets || {};
  const monthLabel = historyViewedMonth.toLocaleDateString([], { year: "numeric", month: "long" });

  const monthHeading = document.createElement("p");
  monthHeading.className = "card-title";
  monthHeading.textContent = monthLabel;
  modalBody.appendChild(monthHeading);

  let html = "";
  if (widgets.hours !== false) {
    html += `<p class="card-title">Hours</p><p>${s.monthHours.toFixed(1)}h this month${isCurrentMonth ? ` · ${s.weekHours.toFixed(1)}h this week` : ""}</p>`;
    if (goal > 0 && isCurrentMonth) {
      const pct = Math.min(100, Math.round((s.monthHours / goal) * 100));
      html += `<p>Monthly hours goal: <strong>${pct}%</strong> of ${goal}h</p>`;
    }
  }
  if (widgets.shifts !== false) {
    html += `<p class="card-title">Shifts</p><p>${s.monthShiftCount} actual shifts this month</p>`;
  }
  if (widgets.pay !== false) {
    html += `<p class="card-title">Total pay</p><p><button class="breakdown-link" id="more-pay-breakdown" type="button">${formatILS(s.monthPay)}</button> this month${isCurrentMonth ? ` · ${formatILS(s.weekPay)} this week` : ""}</p>`;
  }
  if (widgets.averages !== false) {
    html += `<p class="card-title">Averages</p><p>${s.avgHoursPerShift.toFixed(1)}h/shift · ${formatILS(s.avgPayPerShift)}/shift · ${formatILS(s.avgHourlyPay)}/h effective</p>`;
  }
  if (widgets.luba !== false) {
    html += `<p class="card-title">Luba points</p><p>${s.lubaEarned} earned − ${s.lubaSpent} spent = ${s.lubaBalance} balance</p><p>Used: ${s.countByType.meat} בשרי (${s.spentByType.meat} pts) · ${s.countByType.dairy} חלבי (${s.spentByType.dairy} pts)${s.countByType.manual ? ` · ${s.countByType.manual} manual (${s.spentByType.manual} pts)` : ""}</p>`;
  }
  const summary = document.createElement("div");
  summary.innerHTML = html;
  modalBody.appendChild(summary);

  const payBreakdownBtn = summary.querySelector("#more-pay-breakdown");
  if (payBreakdownBtn) {
    payBreakdownBtn.addEventListener("click", () => {
      closeModal();
      openMonthlyBreakdownModal(s.monthPunches, historyViewedMonth);
    });
  }

  if (widgets.export !== false) {
    const exportRow = document.createElement("div");
    exportRow.style.display = "flex";
    exportRow.style.gap = "10px";
    const exportXlsxBtn = document.createElement("button");
    exportXlsxBtn.className = "secondary-button";
    exportXlsxBtn.textContent = "Export Excel";
    exportXlsxBtn.style.marginBottom = "0";
    exportXlsxBtn.addEventListener("click", () => exportMonthToXlsx(s.monthPunches, historyViewedMonth));
    const exportPdfBtn = document.createElement("button");
    exportPdfBtn.className = "secondary-button";
    exportPdfBtn.textContent = "Export PDF";
    exportPdfBtn.style.marginBottom = "0";
    exportPdfBtn.addEventListener("click", () => exportMonthToPdf(s.monthPunches, historyViewedMonth));
    exportRow.append(exportXlsxBtn, exportPdfBtn);
    modalBody.appendChild(exportRow);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "btn-primary";
  addBtn.textContent = "+ Add shift manually";
  addBtn.addEventListener("click", () => {
    closeModal();
    openManualEntryModal();
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-plain";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);

  modalActions.append(closeBtn, addBtn);
}

document.getElementById("btn-open-more").addEventListener("click", openMoreModal);

function openManualEntryModal() {
  openModal("Add shift manually");

  const inFields = createDateTimeFields("Clock in");
  const outFields = createDateTimeFields("Clock out");

  const errorP = document.createElement("p");
  errorP.className = "field-hint";

  modalBody.append(inFields.label, inFields.dateInput, inFields.timeInput, outFields.label, outFields.dateInput, outFields.timeInput, errorP);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Continue";
  saveBtn.addEventListener("click", async () => {
    const clockInDate = parseDateTimeFields(inFields.dateInput, inFields.timeInput);
    const clockOutDate = parseDateTimeFields(outFields.dateInput, outFields.timeInput);
    if (!clockInDate || !clockOutDate) {
      errorP.textContent = "Enter both clock-in and clock-out as a valid date and time (HH:MM).";
      return;
    }
    if (clockOutDate <= clockInDate) {
      errorP.textContent = "Clock out must be after clock in.";
      return;
    }

    closeModal();
    const pickedShift = await resolveShiftForClockIn(clockInDate);
    if (!pickedShift) return; // user cancelled the shift picker

    const shift = await resolveActualShift(pickedShift, clockOutDate);
    const shiftType = state.settings.trackShiftType ? await promptShiftType() : "";
    const { punch } = buildPunch(clockInDate, clockOutDate, shift, pickedShift, shiftType);
    state.punches.push(punch);
    saveState();
    renderHistory();
    renderHome();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(cancelBtn, saveBtn);
}

// ---------- edit an existing punch ----------

function openEditPunchModal(punch) {
  openModal("Edit shift");

  const summary = document.createElement("p");
  summary.innerHTML = `Luba points: <strong>${punch.mealPoints}</strong> (${punch.voucherNote}) &nbsp;·&nbsp; Pay: <strong>${formatILS(punch.payILS)}</strong> <button class="breakdown-link" type="button">breakdown</button>`;
  summary.querySelector(".breakdown-link").addEventListener("click", () => openPayBreakdownModal(punch));
  modalBody.appendChild(summary);

  const inFields = createDateTimeFields("Clock in", new Date(punch.clockInISO));
  const outFields = createDateTimeFields("Clock out", new Date(punch.clockOutISO));

  const errorP = document.createElement("p");
  errorP.className = "field-hint";

  modalBody.append(inFields.label, inFields.dateInput, inFields.timeInput, outFields.label, outFields.dateInput, outFields.timeInput, errorP);

  let editedShiftType = punch.shiftType || "";
  if (state.settings.trackShiftType) {
    // A plain inline <select> here (not a nested modal) — this app has a single shared
    // modal, so opening another one while this edit modal is still visible would wipe
    // out this whole form instead of stacking on top of it.
    const typeLabel = document.createElement("label");
    typeLabel.className = "field-label";
    typeLabel.textContent = "Shift type";
    const typeSelect = document.createElement("select");
    typeSelect.className = "field-input";
    typeSelect.innerHTML = `<option value="">None</option>` + SHIFT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
    typeSelect.value = editedShiftType;
    typeSelect.addEventListener("change", () => {
      editedShiftType = typeSelect.value;
    });
    modalBody.append(typeLabel, typeSelect);
  }

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const clockInDate = parseDateTimeFields(inFields.dateInput, inFields.timeInput);
    const clockOutDate = parseDateTimeFields(outFields.dateInput, outFields.timeInput);
    if (!clockInDate || !clockOutDate) {
      errorP.textContent = "Enter both clock-in and clock-out as a valid date and time (HH:MM).";
      return;
    }
    if (clockOutDate <= clockInDate) {
      errorP.textContent = "Clock out must be after clock in.";
      return;
    }

    const clockInChanged = clockInDate.getTime() !== new Date(punch.clockInISO).getTime();
    const changedFields = [];
    if (clockInChanged) changedFields.push("clockIn");
    if (clockOutDate.getTime() !== new Date(punch.clockOutISO).getTime()) changedFields.push("clockOut");

    closeModal();

    let shift, pickedShift;
    if (clockInChanged) {
      // The clock-in time moved, so the whole shift eligibility window (±30 min) has to be
      // re-evaluated from scratch — an old match (e.g. an 11:00 shift) must not survive a
      // move to 13:50, it needs to be re-decided against the new time.
      pickedShift = await resolveShiftForClockIn(clockInDate);
      if (!pickedShift) return; // user cancelled the shift picker — leave the punch unedited
    } else {
      // Only the clock-out moved: keep the shift's start fixed, re-match just the end.
      const [originalStart, originalEnd] = punch.shiftLabel.split("-");
      pickedShift = { start: originalStart, end: originalEnd, points: punch.mealPoints, vouchers: punch.voucherNote };
    }
    shift = await resolveActualShift(pickedShift, clockOutDate);
    const { punch: recalculated } = buildPunch(clockInDate, clockOutDate, shift, pickedShift, editedShiftType);

    const priorEditedFields = punch.editedFields || [];
    const editedFields = [...new Set([...priorEditedFields, ...changedFields])];
    Object.assign(punch, recalculated, { id: punch.id, editedFields });
    saveState();
    renderHistory();
    renderHome();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    closeModal();
    openModal("Delete this shift?");
    const p = document.createElement("p");
    p.textContent = `Delete the ${punch.shiftLabel} shift on ${formatDate(new Date(punch.clockInISO))}? This can't be undone.`;
    modalBody.appendChild(p);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-danger";
    confirmBtn.textContent = "Delete";
    confirmBtn.addEventListener("click", () => {
      state.punches = state.punches.filter((p) => p.id !== punch.id);
      saveState();
      closeModal();
      renderHistory();
      renderHome();
    });

    const cancelDeleteBtn = document.createElement("button");
    cancelDeleteBtn.className = "btn-plain";
    cancelDeleteBtn.textContent = "Cancel";
    cancelDeleteBtn.addEventListener("click", closeModal);

    modalActions.append(cancelDeleteBtn, confirmBtn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(deleteBtn, cancelBtn, saveBtn);
}

// ---------- monthly pay breakdown ----------

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Aggregates every punch's stored per-shift breakdown into one month-wide summary:
// hours (and ILS) per exact rate percentage, the IDF bonus (still per-shift), and the
// admin-only seniority bonus estimate (a separate monthly lump sum — see
// computeSeniorityBonusForMonth — based on hours worked two months earlier, not on any
// of this month's own punches, and 0 for anyone who isn't admin).
function computeMonthlyPayBreakdown(monthPunches, monthDate) {
  // Keyed by a label (not just the raw percent) so the Shabbat 300% bucket can be
  // split into its two CBA-mandated components — "200% Shabbat hours" + "100%
  // weekly-rest addition" — without colliding with genuine 100%/200% day-rate
  // buckets that might also appear in the same month.
  const rateBuckets = {}; // key -> { label, sortRate, hours, amountILS } — amount uses each punch's
                           // OWN wage at the time it was worked, so a later wage change never distorts past months.
  let totalPreBonus = 0;
  let totalIdfAmount = 0;
  const idfPercentsUsed = new Set();

  for (const p of monthPunches) {
    const pay = p.payBreakdown;
    if (!pay || !pay.hoursByRate) continue; // older entries predating this breakdown format

    const wage = pay.baseWageILS > 0 ? pay.baseWageILS : BASE_WAGE_ILS;
    for (const r of pay.hoursByRate) {
      if (r.ratePercent === 300) {
        // Sorted to the end (past any real 100%-225% tiers) and kept adjacent to
        // each other, Shabbat-hours first then rest-addition — matching the order
        // the reference rate table itself presents these two components in.
        if (!rateBuckets.shabbat200) rateBuckets.shabbat200 = { label: "Shabbat hours (200%)", sortRate: 300, hours: 0, amountILS: 0 };
        if (!rateBuckets.rest100) rateBuckets.rest100 = { label: "Weekly rest addition (100%)", sortRate: 300.5, hours: 0, amountILS: 0 };
        rateBuckets.shabbat200.hours += r.hours;
        rateBuckets.shabbat200.amountILS += r.hours * wage * 2.0;
        rateBuckets.rest100.hours += r.hours;
        rateBuckets.rest100.amountILS += r.hours * wage * 1.0;
      } else {
        const key = `rate${r.ratePercent}`;
        if (!rateBuckets[key]) rateBuckets[key] = { label: `Hours at ${r.ratePercent}%`, sortRate: r.ratePercent, hours: 0, amountILS: 0 };
        rateBuckets[key].hours += r.hours;
        rateBuckets[key].amountILS += r.hours * wage * (r.ratePercent / 100);
      }
    }

    const base = pay.preBonusPayILS;
    const afterIdf = pay.idfBonusPercent ? base * (1 + pay.idfBonusPercent / 100) : base;

    totalPreBonus += base;
    totalIdfAmount += afterIdf - base;
    if (pay.idfBonusPercent) idfPercentsUsed.add(pay.idfBonusPercent);
  }

  const hoursByRate = Object.values(rateBuckets)
    .map((v) => ({
      label: v.label,
      sortRate: v.sortRate,
      hours: round2(v.hours),
      amountILS: round2(v.amountILS),
    }))
    .sort((a, b) => a.sortRate - b.sortRate);

  const seniorityBonus = computeSeniorityBonusForMonth(monthDate);

  return {
    hoursByRate,
    totalPreBonus: round2(totalPreBonus),
    totalIdfAmount: round2(totalIdfAmount),
    totalProductivityAmount: seniorityBonus,
    totalFinal: round2(totalPreBonus + totalIdfAmount + seniorityBonus),
    anyProductivityBonus: seniorityBonus > 0,
    idfPercentsUsed,
  };
}

function openMonthlyBreakdownModal(monthPunches, monthDate) {
  const monthLabel = monthDate.toLocaleDateString([], { year: "numeric", month: "long" });
  openModal(`Pay breakdown — ${monthLabel}`);

  // The seniority bonus (admin-only) can be non-zero even in a month with no shifts of
  // its own (it's based on hours worked two months earlier), so it's always computed —
  // only the per-shift rate breakdown is skipped when there's nothing this month.
  const b = computeMonthlyPayBreakdown(monthPunches, monthDate);

  if (!monthPunches.length && !b.totalProductivityAmount) {
    modalBody.innerHTML = `<p class="field-hint">No shifts this month.</p>`;
  } else {
    const rateRows = b.hoursByRate.map((r) => [r.label, `${r.hours}h — ${formatILS(r.amountILS)}`]);
    const idfLabel = b.idfPercentsUsed.size === 1
      ? `+${[...b.idfPercentsUsed][0]}% IDF bonus`
      : `IDF bonus`;
    const rows = [
      ...rateRows,
      ["Before bonuses", formatILS(b.totalPreBonus)],
      [
        "+10% seniority bonus (estimate, unconfirmed)",
        b.anyProductivityBonus ? formatILS(b.totalProductivityAmount) : "Not applied",
      ],
      [idfLabel, b.idfPercentsUsed.size ? formatILS(b.totalIdfAmount) : "Not applied"],
      ["Total pay this month", formatILS(b.totalFinal)],
    ];
    modalBody.innerHTML = rows.map(([label, value]) => `<p>${label}: <strong>${value}</strong></p>`).join("");
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);

  // Gated behind a feature flag (admin-only for now) while the underlying pay
  // formula is being re-verified against real payslips with payroll's help.
  const role = state?.settings?.role || "user";
  if (canSeeFeature("salarySimulator", role)) {
    const calcBtn = document.createElement("button");
    calcBtn.className = "btn-plain";
    calcBtn.textContent = "🧮 Salary Simulator";
    calcBtn.addEventListener("click", () => {
      closeModal();
      openSalarySimulatorModal();
    });
    modalActions.appendChild(calcBtn);
  }
}

// ---------- salary simulator (shift simulator + rules explainer) ----------

function openSalarySimulatorModal(initialTab = "simulator") {
  openModal("🧮 Salary Simulator");

  const tabBar = document.createElement("div");
  tabBar.className = "segmented-control";
  const simTabBtn = document.createElement("button");
  simTabBtn.type = "button";
  simTabBtn.className = "segmented-option";
  simTabBtn.textContent = "🧮 Shift Simulator";
  const rulesTabBtn = document.createElement("button");
  rulesTabBtn.type = "button";
  rulesTabBtn.className = "segmented-option";
  rulesTabBtn.textContent = "📖 Salary Rules";
  tabBar.append(simTabBtn, rulesTabBtn);

  const contentArea = document.createElement("div");
  modalBody.append(tabBar, contentArea);

  function showTab(tab) {
    simTabBtn.classList.toggle("active", tab === "simulator");
    rulesTabBtn.classList.toggle("active", tab === "rules");
    contentArea.innerHTML = "";
    if (tab === "simulator") renderShiftSimulatorTab(contentArea);
    else renderSalaryRulesTab(contentArea);
  }

  simTabBtn.addEventListener("click", () => showTab("simulator"));
  rulesTabBtn.addEventListener("click", () => showTab("rules"));
  showTab(initialTab);

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);
}

// Read-only "what would this shift pay?" preview — runs the real calculatePay() engine
// live against whatever the user types, but never touches state.punches or saveState().
function renderShiftSimulatorTab(container) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const dateLabel = document.createElement("label");
  dateLabel.className = "field-label";
  dateLabel.textContent = "Date";
  const dateInput = document.createElement("input");
  dateInput.className = "field-input";
  dateInput.type = "date";
  dateInput.value = todayStr;

  const startLabel = document.createElement("label");
  startLabel.className = "field-label";
  startLabel.textContent = "Start time";
  const startInput = document.createElement("input");
  startInput.className = "field-input";
  startInput.type = "text";
  startInput.placeholder = "HH:MM (24h)";
  startInput.inputMode = "numeric";
  startInput.maxLength = 5;
  startInput.value = "12:00";
  attachTimeInputMask(startInput);

  const endLabel = document.createElement("label");
  endLabel.className = "field-label";
  endLabel.textContent = "End time";
  const endInput = document.createElement("input");
  endInput.className = "field-input";
  endInput.type = "text";
  endInput.placeholder = "HH:MM (24h)";
  endInput.inputMode = "numeric";
  endInput.maxLength = 5;
  endInput.value = "20:00";
  attachTimeInputMask(endInput);

  const resultBox = document.createElement("div");

  const hint = document.createElement("p");
  hint.className = "field-hint";
  hint.textContent = "Simulation only — this is never saved to your account.";

  container.append(dateLabel, dateInput, startLabel, startInput, endLabel, endInput, resultBox, hint);

  function recompute() {
    if (!dateInput.value || !TIME_24H_RE.test(startInput.value) || !TIME_24H_RE.test(endInput.value)) {
      resultBox.innerHTML = `<p class="field-hint">Enter a date, start time, and end time (HH:MM, 24h).</p>`;
      return;
    }
    const clockIn = new Date(`${dateInput.value}T${startInput.value}`);
    let clockOut = new Date(`${dateInput.value}T${endInput.value}`);
    if (clockOut <= clockIn) clockOut = new Date(clockOut.getTime() + 24 * 3600000); // crosses midnight

    let pay;
    try {
      pay = calculatePay(clockIn, clockOut, {
        baseWageILS: state.settings.baseWageILS || BASE_WAGE_ILS,
        idfBonusPercent: state.settings.idfBonusPercent || 0,
        useUpdatedNightThresholds: usesCorrectedOvertimeModel(),
      });
    } catch (err) {
      resultBox.innerHTML = `<p class="field-error">${err.message}</p>`;
      return;
    }

    const rateRows = [];
    for (const r of pay.hoursByRate) {
      if (r.ratePercent === 300) {
        rateRows.push(`<p>Shabbat hours (200%): <strong>${r.hours}h</strong></p>`);
        rateRows.push(`<p>Weekly rest addition (100%): <strong>${r.hours}h</strong></p>`);
      } else {
        rateRows.push(`<p>Hours at ${r.ratePercent}%: <strong>${r.hours}h</strong></p>`);
      }
    }
    resultBox.innerHTML = `
      ${rateRows.join("") || `<p class="field-hint">No hours yet — check the times above.</p>`}
      ${pay.breakMinutesDeducted ? `<p class="field-hint">Unpaid break deducted: ${pay.breakMinutesDeducted} min</p>` : ""}
      <p class="field-hint">+10% seniority bonus: not shown here — it's a monthly total, not part of any single shift (see the Salary Rules tab)</p>
      <p class="sim-total">Estimated pay for this shift: ${formatILS(pay.finalPayILS)}</p>
    `;
  }

  [dateInput, startInput, endInput].forEach((el) => el.addEventListener("input", recompute));
  recompute();
}

function renderSalaryRulesTab(container) {
  const wage = state.settings.baseWageILS || BASE_WAGE_ILS;
  const sections = [
    {
      title: "💰 Base wage",
      open: true,
      body: `<p>Every hour is paid at least the base rate — currently <strong>${formatILS(wage)}/hour</strong> (matches minimum wage unless you've set a different rate in Settings).</p>`,
    },
    {
      title: "🕐 Time-of-day zones",
      body: `
        <p>Day (06:00–16:00): <strong>100%</strong></p>
        <p>Evening (16:00–22:00): <strong>130%</strong></p>
        <p>Night (22:00–06:00): <strong>150%</strong></p>
        <p class="field-hint">If a shift reaches far enough into the night window, the WHOLE shift (up to the cap below) is paid at the night rate — not just the part that's literally after 22:00.</p>
      `,
    },
    {
      title: "🌙 Night cap & overtime",
      body: usesCorrectedOvertimeModel()
        ? `<p>A night shift is paid at 150% for up to <strong>7 hours and 5 minutes</strong>. Anything beyond that, in the same shift, is paid at <strong>225%</strong>.</p>
           <p class="field-hint">Admin-only model update (2026-08-01): re-derived from a real June 2026 payslip shift, matched to the minute. A shift also now fully "flips" to the night rate once it overlaps the night window by <strong>2 hours 15 minutes</strong> (was 2h16m). Still based on a single confirmed example.</p>`
        : `<p>A night shift is paid at 150% for up to <strong>7 hours</strong>. Anything beyond that, in the same shift, is paid at <strong>225%</strong>.</p>
           <p class="field-hint">A night shift shorter than 7 hours has no overtime portion at all — the whole thing stays at 150%.</p>`,
    },
    {
      title: "☕ Unpaid break",
      body: `<p>Any shift longer than 6 hours has <strong>30 minutes</strong> deducted before pay is calculated — taken off the end of the shift, not the middle.</p>`,
    },
    {
      title: "🕯️ Shabbat",
      body: `<p>Hours worked on Shabbat are paid <strong>300%</strong> in total.</p>`,
    },
    {
      title: "📈 Seniority bonus (10%) — unconfirmed estimate",
      body: (() => {
        const testMonth = new Date();
        const testAmount = computeSeniorityBonusForMonth(testMonth);
        const testLabel = testMonth.toLocaleDateString([], { year: "numeric", month: "long" });
        return `
          <p class="field-hint">Now included in your real monthly total (admin only) — but the exact rule is still unconfirmed with payroll (see the questions sent to Bar), so treat this as an estimate, not a guarantee.</p>
          <p>Model: 10% of hours worked <strong>two months earlier</strong>, re-rated to today's wage.</p>
          <p>Estimate for ${testLabel} under this model: <strong>${testAmount > 0 ? formatILS(testAmount) : "₪0.00 (no data two months back, or not yet eligible)"}</strong></p>
        `;
      })(),
    },
  ];

  for (const s of sections) {
    const details = document.createElement("details");
    details.className = "card settings-section";
    if (s.open) details.open = true;
    details.innerHTML = `
      <summary class="settings-section-header"><span>${s.title}</span><span class="chevron">▾</span></summary>
      <div class="settings-section-body">${s.body}</div>
    `;
    container.appendChild(details);
  }
}

// ---------- pay breakdown (single shift) ----------

function openPayBreakdownModal(punch) {
  openModal("Pay breakdown");
  const pay = punch.payBreakdown;

  if (!pay || !pay.hoursByRate) {
    modalBody.innerHTML = `<p class="field-hint">Breakdown not available for this entry.</p>`;
  } else {
    // Only rates that actually applied to this shift show up — nothing at 0 hours.
    // Shabbat's flat 300% is split into its two CBA-mandated components (200%
    // Shabbat hours + 100% weekly-rest addition) for clarity — same hours, same
    // total pay, just broken into the two lines a real payslip would show.
    const rateRows = [];
    for (const r of pay.hoursByRate) {
      if (r.ratePercent === 300) {
        rateRows.push([`Shabbat hours (200%)`, `${r.hours}h`]);
        rateRows.push([`Weekly rest addition (100%)`, `${r.hours}h`]);
      } else {
        rateRows.push([`Hours at ${r.ratePercent}%`, `${r.hours}h`]);
      }
    }
    const rows = [...rateRows];
    if (pay.breakMinutesDeducted) {
      rows.push(["Unpaid break deducted", `${pay.breakMinutesDeducted} min`]);
    }
    rows.push(["Before bonus", formatILS(pay.preBonusPayILS)]);
    rows.push(["+10% seniority bonus", "Not a per-shift amount — see the monthly breakdown"]);
    if (pay.idfBonusPercent) {
      rows.push([`+${pay.idfBonusPercent}% IDF bonus`, "Applied"]);
    }
    rows.push(["Total pay for this shift", formatILS(pay.finalPayILS)]);
    modalBody.innerHTML = rows.map(([label, value]) => `<p>${label}: <strong>${value}</strong></p>`).join("");
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);
}

// ---------- guided tour ----------

const tourSpotlight = document.getElementById("tour-spotlight");
const tourTooltip = document.getElementById("tour-tooltip");
const tourArrow = document.getElementById("tour-arrow");
const tourTooltipText = document.getElementById("tour-tooltip-text");
const tourSkipBtn = document.getElementById("tour-skip-btn");
const tourNextBtn = document.getElementById("tour-next-btn");

let tourStepIndex = -1;
let tourCleanupFns = [];

const TOUR_STEPS = [
  {
    // Step 1: Home — real click on Clock In, then wait for the (guaranteed,
    // tour-mode) shift picker modal to actually open before advancing.
    target: () => document.getElementById("btn-clock"),
    text: "בוא ננסה! לחץ על כפתור הכניסה כדי להתחיל משמרת.",
    advanceType: "modalOpen",
  },
  {
    // Step 2: the shift picker modal itself (opened by step 1's click).
    target: () => document.getElementById("modal"),
    text: "מצוין! כעת בחר את סוג המשמרת שלך לקבלת חישוב שכר ונקודות מדויק.",
    advanceType: "modalClose",
  },
  {
    // Step 3: point at the Attendance tab and wait for a real tap — the tour
    // does not navigate here itself.
    target: () => document.querySelector('[data-nav="history"]'),
    text: "כל הכבוד! המשמרת באוויר. כאן תוכל לצפות בנתונים בזמן אמת, וללחוץ על בועת משמרת ספציפית כדי לערוך שעות, לשנות תאריך או להסיר אותה.",
    advanceType: "click",
  },
  {
    // Step 4: tour navigates to Luba itself; informational only.
    autoNavigateTo: "cafeteria",
    target: () => document.getElementById("btn-log-points"),
    text: "השתמשת בנקודות? לחץ כאן כדי לעדכן. מומלץ להגדיר תזכורת במסך ההגדרות בסוף יום כדי לשמור על מעקב מדויק!",
    advanceType: "manual",
  },
  {
    // Step 5: Who's In — shown as a teaser regardless of the real feature-flag
    // gating; forces the nav tab visible for the rest of the tour (real gated
    // visibility is restored only once the whole tour ends, in completeTour()),
    // and leaves a "Coming soon" ribbon on it once this step ends.
    autoNavigateTo: "whosonclock",
    target: () => document.querySelector('[data-nav="whosonclock"]'),
    text: "תמיד יודעים מי בפנים! גלה מי עובד איתך עכשיו, מי מגיע בהמשך ואיך הלו\"ז שלכם חופף.",
    advanceType: "manual",
    onEnter: () => {
      document.querySelector('[data-nav="whosonclock"]').hidden = false;
    },
    onLeave: () => {
      document.getElementById("woc-coming-soon-badge").hidden = false;
    },
  },
  {
    // Step 6: Settings — specifically the Employment & Pay section, since the
    // tooltip talks about pay rates (the first .settings-section in DOM order
    // is actually Personal Info, which doesn't match this text at all).
    autoNavigateTo: "settings",
    target: () => Array.from(document.querySelectorAll(".settings-section")).find((el) => el.textContent.includes("Employment")),
    text: "הגענו להגדרות! כאן תוכל להתאים אישית את תעריפי השכר, התזכורות וההעדפות שלך.",
    advanceType: "manual",
  },
];

const tourClickBlocker = document.getElementById("tour-click-blocker");
const tourBlockerBands = {
  top: tourClickBlocker.querySelector('[data-band="top"]'),
  bottom: tourClickBlocker.querySelector('[data-band="bottom"]'),
  left: tourClickBlocker.querySelector('[data-band="left"]'),
  right: tourClickBlocker.querySelector('[data-band="right"]'),
};

// Leaves a rectangular hole over the target's rect (so the one action the
// step actually needs stays clickable) by covering everywhere else with 4
// bands — or covers the full viewport with just the top band for steps
// where no interaction with the underlying page is expected. Not needed for
// step 2 (the shift-picker modal): it already sits at a higher z-index than
// the blocker, so its own buttons stay reachable regardless.
function updateClickBlockerHole(rect, hasHole) {
  const { top, bottom, left, right } = tourBlockerBands;
  if (!hasHole) {
    top.style.cssText = "top:0; left:0; width:100vw; height:100vh;";
    bottom.style.display = "none";
    left.style.display = "none";
    right.style.display = "none";
    return;
  }
  const pad = 6;
  const t = Math.max(0, rect.top - pad);
  const b = Math.min(window.innerHeight, rect.bottom + pad);
  const l = Math.max(0, rect.left - pad);
  const r = Math.min(window.innerWidth, rect.right + pad);

  top.style.cssText = `display:block; top:0; left:0; width:100vw; height:${t}px;`;
  bottom.style.cssText = `display:block; top:${b}px; left:0; width:100vw; height:${Math.max(0, window.innerHeight - b)}px;`;
  left.style.cssText = `display:block; top:${t}px; left:0; width:${l}px; height:${Math.max(0, b - t)}px;`;
  right.style.cssText = `display:block; top:${t}px; left:${r}px; width:${Math.max(0, window.innerWidth - r)}px; height:${Math.max(0, b - t)}px;`;
}

function positionTourStep(targetEl, hasHole) {
  const rect = targetEl.getBoundingClientRect();
  const pad = 6;
  tourSpotlight.style.top = `${rect.top - pad}px`;
  tourSpotlight.style.left = `${rect.left - pad}px`;
  tourSpotlight.style.width = `${rect.width + pad * 2}px`;
  tourSpotlight.style.height = `${rect.height + pad * 2}px`;
  updateClickBlockerHole(rect, hasHole);

  const tooltipWidth = 300;
  const tooltipHeight = tourTooltip.offsetHeight || 140;
  const spaceBelow = window.innerHeight - rect.bottom;
  const goBelow = spaceBelow > tooltipHeight + 30;

  const left = Math.max(12, Math.min(rect.left, window.innerWidth - tooltipWidth - 12));
  tourTooltip.style.left = `${left}px`;
  if (goBelow) {
    tourTooltip.style.top = `${rect.bottom + 24}px`;
    tourArrow.className = "tour-arrow tour-arrow-up";
    tourArrow.textContent = "▲";
  } else {
    tourTooltip.style.top = `${Math.max(12, rect.top - tooltipHeight - 24)}px`;
    tourArrow.className = "tour-arrow tour-arrow-down";
    tourArrow.textContent = "▼";
  }
}

function teardownTourStep() {
  tourCleanupFns.forEach((fn) => fn());
  tourCleanupFns = [];
}

function hideTourUI() {
  tourSpotlight.hidden = true;
  tourTooltip.hidden = true;
  tourClickBlocker.hidden = true;
  tourSkipBtn.hidden = true;
  teardownTourStep();
}

function runTourStep(index) {
  teardownTourStep();
  const step = TOUR_STEPS[index];
  if (!step) {
    finishTour();
    return;
  }

  if (step.autoNavigateTo) showScreen(step.autoNavigateTo);

  const target = step.target();
  if (!target) {
    // Target genuinely missing (shouldn't happen) — skip rather than get stuck.
    advanceTour();
    return;
  }

  if (step.onEnter) step.onEnter();

  tourTooltipText.textContent = step.text;
  tourNextBtn.hidden = step.advanceType !== "manual";
  tourSpotlight.hidden = false;
  tourTooltip.hidden = false;
  tourClickBlocker.hidden = false;
  tourSkipBtn.hidden = false;

  const hasHole = step.advanceType === "modalOpen" || step.advanceType === "click";
  const reposition = () => positionTourStep(target, hasHole);
  reposition();
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  tourCleanupFns.push(() => window.removeEventListener("scroll", reposition, true));
  tourCleanupFns.push(() => window.removeEventListener("resize", reposition));

  if (step.advanceType === "manual") {
    tourNextBtn.onclick = () => advanceTour();
  } else if (step.advanceType === "click") {
    const handler = () => advanceTour();
    target.addEventListener("click", handler, { once: true });
    tourCleanupFns.push(() => target.removeEventListener("click", handler));
  } else if (step.advanceType === "modalOpen" || step.advanceType === "modalClose") {
    const wantHidden = step.advanceType === "modalOpen" ? false : true;
    const observer = new MutationObserver(() => {
      if (modalBackdrop.hidden === wantHidden) advanceTour();
    });
    observer.observe(modalBackdrop, { attributes: true, attributeFilter: ["hidden"] });
    tourCleanupFns.push(() => observer.disconnect());
  }
}

function advanceTour() {
  const finishedStep = TOUR_STEPS[tourStepIndex];
  if (finishedStep?.onLeave) finishedStep.onLeave();
  tourStepIndex++;
  runTourStep(tourStepIndex);
}

function showTourFinishModal() {
  openModal("🎉 סיימנו!");
  const p = document.createElement("p");
  p.textContent = "אתה מוכן להתחיל לעבוד עם TrackO'clock. בהצלחה!";
  modalBody.appendChild(p);
  const doneBtn = document.createElement("button");
  doneBtn.className = "btn-primary";
  doneBtn.textContent = "התחל";
  doneBtn.addEventListener("click", () => {
    closeModal();
    completeTour();
  });
  modalActions.appendChild(doneBtn);
}

function completeTour() {
  document.getElementById("woc-coming-soon-badge").hidden = true;
  exitTourSandbox();
  state.settings.isFirstLogin = false;
  saveState();
  applyRoleVisibility(); // restores the Who's In tab's real gated visibility now that the tour is over
}

function finishTour() {
  hideTourUI();
  showTourFinishModal();
}

function skipTour() {
  hideTourUI();
  if (!modalBackdrop.hidden) closeModal(); // dismiss a lingering shift-picker (or similar) from mid-tour
  completeTour();
}

tourSkipBtn.addEventListener("click", skipTour);

function startTour() {
  enterTourSandbox();
  showScreen("home");
  tourStepIndex = 0;
  runTourStep(0);
}

document.getElementById("btn-replay-tour").addEventListener("click", startTour);

// ---------- init ----------

boot();
