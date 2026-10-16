import { auth, db } from "./firebase.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { doc, getDoc, getDocs, setDoc, updateDoc, serverTimestamp, collection, query, where, orderBy, limit, onSnapshot, writeBatch, increment } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ===================== DATA ===================== */
// Lobbies are created by the admin (admin.html) and stored in Firestore: lobbies/{id}
let LOBBIES = [];

async function loadLobbies(){
  try{
    const snap = await getDocs(query(collection(db, "lobbies"), where("status", "==", "open")));
    LOBBIES = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .sort((x, y) => (y.createdAt?.seconds || 0) - (x.createdAt?.seconds || 0));
    LOBBIES.forEach(l => { LOBBY_ICONS[l.id] = LOBBY_ICONS[l.icon] || LOBBY_ICONS["br-solo"]; });
  }catch(err){
    console.error(err);
    LOBBIES = [];
  }
  renderLobbies();
  if(currentUser){
    renderHome();
    if(typeof renderSearch === "function") renderSearch();
  }
}

// simple original line icons, one per lobby mode
const LOBBY_ICONS = {
  "br-solo":       '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  "ranked-rush":   '<path d="m6 14 6-6 6 6M6 20l6-6 6 6"/>',
  "mp-domination": '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
  "snipers-only":  '<circle cx="12" cy="12" r="9"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
  "clip-bounty":   '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3V9Z"/>',
  "gunfight":      '<path d="m5 5 14 14M19 5 5 19"/><circle cx="12" cy="12" r="3"/>'
};
const lobbyIconSvg = (id, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${LOBBY_ICONS[id] || ""}</svg>`;

const LEADERBOARD = [
  { name:"JayMoss", sub:"Ranked Rush · 14 wins", amount:82.40, color:"#8B5CF6" },
  { name:"NyxHunter", sub:"Gunfight Gauntlet · 9 wins", amount:66.10, color:"#EC4899" },
  { name:"ZeroKelvin", sub:"Isolated Solo Drop · 11 wins", amount:54.75, color:"#F97316" },
  { name:"Ashlynn.gg", sub:"Domination Ladder · 7 wins", amount:41.20, color:"#22D3EE" },
  { name:"KairoSix", sub:"Snipers Only · 6 wins", amount:33.90, color:"#34D399" },
];

const WITHDRAW_MIN = 30;   // balance needed before a user can withdraw

/* ===================== FIREBASE STATE ===================== */
let currentUser = null;      // { id, email, gamertag, uid (CODM UID), avatar }
let walletCache = null;      // in-memory copy of wallets/{id}
let signupInFlight = false;
let welcomeMsg = null;

const getWallet = () => walletCache;
const saveWallet = (_email, w) => {
  walletCache = w;
  if(!currentUser) return;
  setDoc(doc(db, "wallets", currentUser.id), w).catch((err) => {
    console.error(err);
    toast("Couldn't sync your wallet. Check your connection.", "error");
  });
};

function authError(err){
  switch(err && err.code){
    case "auth/email-already-in-use": return "An account with this email already exists.";
    case "auth/invalid-email": return "Enter a valid email address.";
    case "auth/weak-password": return "Password must be at least 6 characters.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Email or password is incorrect.";
    case "auth/too-many-requests": return "Too many attempts. Try again in a few minutes.";
    case "auth/network-request-failed": return "Network error. Check your connection.";
    default: return "Something went wrong. Please try again.";
  }
}

function shrinkImage(dataUrl, max = 256){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/* ===================== TOASTS ===================== */
function toast(msg, type=""){
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

/* ===================== AUTH SCREEN LOGIC ===================== */
const tabs = document.querySelectorAll(".tab");
const forms = document.querySelectorAll(".auth-form");

function switchTab(name){
  tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  forms.forEach(f => f.classList.toggle("active", f.id === `${name}-form`));
}
tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
document.querySelectorAll("[data-switch]").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.switch)));

/* ===================== AUTH MODAL (guest gate) ===================== */
const authModalOverlay = document.getElementById("auth-modal-overlay");

function openAuthModal(tab = "login"){
  switchTab(tab);
  authModalOverlay.classList.add("open");
}
function closeAuthModal(){
  authModalOverlay.classList.remove("open");
}
document.getElementById("close-auth-modal").addEventListener("click", closeAuthModal);
authModalOverlay.addEventListener("click", (e) => {
  if(e.target === authModalOverlay) closeAuthModal();
});

document.getElementById("nav-login-btn").addEventListener("click", () => openAuthModal("login"));
document.getElementById("nav-signup-btn").addEventListener("click", () => openAuthModal("signup"));
document.getElementById("hero-signup-cta").addEventListener("click", () => openAuthModal("signup"));
document.getElementById("hero-login-cta").addEventListener("click", () => openAuthModal("login"));
document.getElementById("hero-primary-cta").addEventListener("click", () => {
  if(currentUser){
    document.getElementById("lobbies").scrollIntoView({ behavior:"smooth" });
  } else {
    openAuthModal("signup");
  }
});

/* Toggle every .auth-only / .guest-only element based on login state */
function setAuthUI(loggedIn){
  document.querySelectorAll(".auth-only").forEach(el => el.classList.toggle("hidden", !loggedIn));
  document.querySelectorAll(".guest-only").forEach(el => el.classList.toggle("hidden", loggedIn));
  document.body.classList.toggle("has-bottom-nav", loggedIn);
  // guests see the whole landing page; signed-in users see one screen at a time
  if(!loggedIn) document.querySelectorAll("[data-view]").forEach(el => el.classList.remove("view-hidden"));
}

// avatar upload preview
const avatarInput = document.getElementById("avatar-input");
const avatarTrigger = document.getElementById("avatar-trigger");
const avatarPreview = document.getElementById("avatar-preview");
const avatarPlus = document.getElementById("avatar-plus");
let avatarDataUrl = null;
avatarTrigger.addEventListener("click", () => avatarInput.click());
avatarInput.addEventListener("change", () => {
  const file = avatarInput.files[0];
  if(!file) return;
  if(file.size > 5*1024*1024){ toast("Image must be under 5MB", "error"); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    avatarDataUrl = e.target.result;
    avatarPreview.src = avatarDataUrl;
    avatarPreview.hidden = false;
    avatarPlus.hidden = true;
  };
  reader.readAsDataURL(file);
});

// signup
document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const accountName = f.accountname.value.trim();
  const gamertag = f.gamertag.value.trim();
  const uid = f.uid.value.trim();
  const email = f.email.value.trim().toLowerCase();
  const password = f.password.value;
  const errorEl = document.querySelector('[data-error-for="signup"]');
  const submitBtn = f.querySelector('button[type="submit"]');
  errorEl.textContent = "";

  if(gamertag.length < 3){ errorEl.textContent = "Gamer tag must be at least 3 characters."; return; }
  if(password.length < 6){ errorEl.textContent = "Password must be at least 6 characters."; return; }

  submitBtn.disabled = true;
  signupInFlight = true;
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const avatar = avatarDataUrl ? await shrinkImage(avatarDataUrl) : null;
    await setDoc(doc(db, "users", cred.user.uid), { accountName, gamertag, uid, email, avatar, createdAt: new Date().toISOString() });
    await setDoc(doc(db, "wallets", cred.user.uid), {
      balance: 10,
      matches: 0,
      wins: 0,
      activeLobby: null,
      history: [{ name:"Welcome bonus", amount:10, date: new Date().toISOString(), type:"pos" }]
    });

    f.reset();
    avatarPreview.hidden = true;
    avatarPlus.hidden = false;
    avatarDataUrl = null;

    await loadSession(cred.user);
    afterSignIn("Account created — welcome to Praxio!");
  } catch(err){
    console.error(err);
    errorEl.textContent = authError(err);
  } finally {
    signupInFlight = false;
    submitBtn.disabled = false;
  }
});

// login
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim().toLowerCase();
  const password = f.password.value;
  const errorEl = document.querySelector('[data-error-for="login"]');
  const submitBtn = f.querySelector('button[type="submit"]');
  errorEl.textContent = "";

  submitBtn.disabled = true;
  welcomeMsg = "Welcome back!";
  try{
    await signInWithEmailAndPassword(auth, email, password);
    f.reset();
  } catch(err){
    welcomeMsg = null;
    errorEl.textContent = authError(err);
  } finally {
    submitBtn.disabled = false;
  }
});

function afterSignIn(msg){
  closeAuthModal();
  window.scrollTo({ top:0, behavior:"smooth" });
  toast(msg, "success");
}

async function logOut(){
  try{ await signOut(auth); } catch(err){ console.error(err); }
  toast("Logged out");
  window.scrollTo({ top:0, behavior:"smooth" });
}
document.getElementById("logout-btn").addEventListener("click", logOut);

/* ===================== APP BOOT ===================== */
// Public landing content renders regardless of auth state.
function boot(){
  renderLobbies();
  syncClock().then(() => { refreshLobbyButtons(); });
  loadLobbies();
  renderLeaderboard();
  initScrollReveal();
}

async function loadSession(fbUser){
  const userRef = doc(db, "users", fbUser.uid);
  const walletRef = doc(db, "wallets", fbUser.uid);
  const [userSnap, walletSnap] = await Promise.all([getDoc(userRef), getDoc(walletRef)]);

  let profile = userSnap.exists() ? userSnap.data() : null;
  if(!profile){
    profile = { gamertag: (fbUser.email || "player").split("@")[0], uid:"", email: fbUser.email, avatar:null, createdAt: new Date().toISOString() };
    await setDoc(userRef, profile);
  }

  let wallet = walletSnap.exists() ? walletSnap.data() : null;
  if(!wallet){
    wallet = { balance:10, matches:0, wins:0, activeLobby:null, history:[] };
    await setDoc(walletRef, wallet);
  }
  wallet.history = wallet.history || [];

  currentUser = { id: fbUser.uid, email: fbUser.email, gamertag: profile.gamertag, uid: profile.uid || "", avatar: profile.avatar || null, accountName: profile.accountName || "", lastChanged: profile.lastChanged || {} };
  walletCache = wallet;

  setAuthUI(true);
  updateBottomNavProfile();
  syncPublicProfile();
  startChats();
  showView("home");
  document.getElementById("profile-initial").textContent = currentUser.gamertag[0].toUpperCase();
  document.getElementById("dropdown-gamertag").textContent = currentUser.gamertag;
  document.getElementById("dropdown-email").textContent = currentUser.email;
  renderWallet();
  loadMyEntries();
}

function clearSession(){
  stopRevealWatcher();
  myEntries = {};
  currentUser = null;
  walletCache = null;
  setAuthUI(false);
  updateBottomNavProfile();
  stopChats();
  closeDrawer();
  profileDropdown.classList.remove("open");
}

/* ===================== WALLET RENDERING ===================== */
function renderWallet(){
  const wallet = getWallet(currentUser.email);
  const balanceStr = `$${wallet.balance.toFixed(2)}`;
  document.getElementById("wallet-balance-nav").textContent = balanceStr;
  document.getElementById("wallet-balance-hero").textContent = balanceStr;
  document.getElementById("drawer-balance").textContent = balanceStr;
  document.getElementById("active-lobby-name").textContent = wallet.activeLobby || "None yet";

  const weekEarnings = wallet.history
    .filter(h => h.type === "pos" && h.name !== "Deposit")
    .reduce((sum,h) => sum + h.amount, 0);
  document.getElementById("stat-week").textContent = `+$${weekEarnings.toFixed(2)}`;
  document.getElementById("stat-xp").textContent = `+${wallet.matches * 15} XP`;

  document.getElementById("drawer-matches").textContent = wallet.matches;
  const winRate = wallet.matches ? Math.round((wallet.wins / wallet.matches) * 100) : 0;
  document.getElementById("drawer-winrate").textContent = `${winRate}%`;

  document.getElementById("withdraw-btn").disabled = wallet.balance < WITHDRAW_MIN;
  document.getElementById("drawer-hint").textContent = wallet.balance < WITHDRAW_MIN
    ? `Withdrawals unlock at $${WITHDRAW_MIN}. You need $${(WITHDRAW_MIN - wallet.balance).toFixed(2)} more.`
    : "You can withdraw your balance.";

  const txList = document.getElementById("tx-list");
  txList.innerHTML = "";
  if(wallet.history.length === 0){
    txList.innerHTML = `<p class="tx-empty">No transactions yet. Join a lobby to get started.</p>`;
  } else {
    [...wallet.history].reverse().forEach(tx => {
      const row = document.createElement("div");
      row.className = "tx-row";
      const date = new Date(tx.date);
      row.innerHTML = `
        <div>
          <p class="tx-name">${tx.name}</p>
          <p class="tx-date">${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</p>
        </div>
        <span class="tx-amount ${tx.type === 'pos' ? 'pos' : 'neg'}">${tx.type === 'pos' ? '+' : '-'}$${Math.abs(tx.amount).toFixed(2)}</span>
      `;
      txList.appendChild(row);
    });
  }

  renderDashboard();
  renderHome();
}

document.getElementById("withdraw-btn").addEventListener("click", () => {
  const wallet = getWallet();
  if(!wallet || wallet.balance < WITHDRAW_MIN){
    toast(`You need $${WITHDRAW_MIN} to withdraw.`, "error");
    return;
  }
  toast("Withdrawals aren't live in this demo yet.", "error");
});

/* ===================== DEPOSIT ===================== */
const DEPOSIT_MIN = 5;
const depositOverlay = document.getElementById("deposit-modal-overlay");
const depositInput = document.getElementById("deposit-amount");
const depositError = document.getElementById("deposit-error");
const depositChips = document.querySelectorAll(".amount-chip");

function openDeposit(){
  depositInput.value = "";
  depositError.textContent = "";
  depositChips.forEach(c => c.classList.remove("active"));
  depositOverlay.classList.add("open");
  setTimeout(() => depositInput.focus(), 250);
}
function closeDeposit(){ depositOverlay.classList.remove("open"); }

depositChips.forEach(chip => {
  chip.addEventListener("click", () => {
    depositInput.value = chip.dataset.amt;
    depositError.textContent = "";
    depositChips.forEach(c => c.classList.toggle("active", c === chip));
  });
});
depositInput.addEventListener("input", () => {
  depositChips.forEach(c => c.classList.toggle("active", c.dataset.amt === depositInput.value));
});
document.getElementById("close-deposit").addEventListener("click", closeDeposit);
depositOverlay.addEventListener("click", (e) => { if(e.target === depositOverlay) closeDeposit(); });
document.getElementById("deposit-btn").addEventListener("click", openDeposit);
document.getElementById("dash-deposit").addEventListener("click", openDeposit);

document.getElementById("confirm-deposit-btn").addEventListener("click", () => {
  const amount = Math.round(parseFloat(depositInput.value) * 100) / 100;
  if(!currentUser){ return; }
  if(!amount || amount < DEPOSIT_MIN){ depositError.textContent = `Minimum deposit is ${money(DEPOSIT_MIN)}.`; return; }
  if(amount > 500){ depositError.textContent = "Maximum deposit is $500.00."; return; }

  const wallet = getWallet();
  wallet.balance = Math.round((wallet.balance + amount) * 100) / 100;
  wallet.history.push({ name:"Deposit", amount, date: new Date().toISOString(), type:"pos" });
  saveWallet(currentUser.email, wallet);
  renderWallet();
  closeDeposit();
  toast(`$${amount.toFixed(2)} added to your wallet`, "success");
});

/* ===================== EDIT PROFILE (7-day lock per field) ===================== */
const EDIT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const EDITABLE_FIELDS = {
  accountName: {
    label: "Account name",
    validate: (v) => (v.length >= 2 && v.length <= 40) ? "" : "Account name must be 2–40 characters."
  },
  gamertag: {
    label: "Gamer tag",
    validate: (v) => /^[A-Za-z0-9._-]{3,20}$/.test(v) ? "" : "Gamer tag must be 3–20 characters: letters, numbers, dot, dash or underscore."
  },
  uid: {
    label: "CODM UID",
    validate: (v) => (v === "" || /^\d{5,20}$/.test(v)) ? "" : "CODM UID must be 5–20 digits."
  }
};

const tsToMs = (t) => !t ? 0 : (typeof t.toMillis === "function" ? t.toMillis() : (new Date(t).getTime() || 0));
function lockedFor(key){
  const last = tsToMs(currentUser.lastChanged && currentUser.lastChanged[key]);
  return Math.max(0, last + EDIT_COOLDOWN_MS - Date.now());
}
function formatWait(ms){
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if(d > 0) return `${d}d ${h}h`;
  if(h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const editOverlay = document.getElementById("edit-modal-overlay");
const editForm = document.getElementById("edit-profile-form");
const editError = document.getElementById("edit-error");
const saveProfileBtn = document.getElementById("save-profile-btn");
let editConfirming = false;

function resetEditConfirm(){
  editConfirming = false;
  saveProfileBtn.textContent = "Save changes";
}

function openEditProfile(){
  if(!currentUser) return;
  editError.textContent = "";
  resetEditConfirm();
  Object.keys(EDITABLE_FIELDS).forEach(key => {
    const input = document.getElementById(`edit-${key}`);
    const note = document.getElementById(`edit-note-${key}`);
    const wait = lockedFor(key);
    input.value = currentUser[key] || "";
    input.disabled = wait > 0;
    note.textContent = wait > 0
      ? `Locked. You can change this again in ${formatWait(wait)}.`
      : "You can change this now. After saving, it locks for 7 days.";
    note.classList.toggle("locked", wait > 0);
  });
  editOverlay.classList.add("open");
}
function closeEditProfile(){ editOverlay.classList.remove("open"); }

editForm.addEventListener("input", () => { editError.textContent = ""; resetEditConfirm(); });
document.getElementById("close-edit").addEventListener("click", closeEditProfile);
editOverlay.addEventListener("click", (e) => { if(e.target === editOverlay) closeEditProfile(); });
document.getElementById("edit-profile-btn").addEventListener("click", openEditProfile);
document.getElementById("dropdown-edit-btn").addEventListener("click", openEditProfile);

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if(!currentUser) return;
  editError.textContent = "";

  const changes = {};
  for(const key of Object.keys(EDITABLE_FIELDS)){
    const input = document.getElementById(`edit-${key}`);
    if(input.disabled) continue;
    const val = input.value.trim();
    if(val === (currentUser[key] || "")) continue;
    const msg = EDITABLE_FIELDS[key].validate(val);
    if(msg){ editError.textContent = msg; resetEditConfirm(); return; }
    changes[key] = val;
  }
  const keys = Object.keys(changes);
  if(!keys.length){ editError.textContent = "Nothing to save. Change a field first."; return; }

  // second click confirms, because the change can't be undone for 7 days
  if(!editConfirming){
    editConfirming = true;
    saveProfileBtn.textContent = "Confirm and lock for 7 days";
    editError.textContent = `${keys.map(k => EDITABLE_FIELDS[k].label).join(", ")} will be locked for 7 days after you save.`;
    return;
  }

  saveProfileBtn.disabled = true;
  try{
    const payload = {};
    keys.forEach(k => {
      payload[k] = changes[k];
      payload[`lastChanged.${k}`] = serverTimestamp();
    });
    const userRef = doc(db, "users", currentUser.id);
    await updateDoc(userRef, payload);

    const snap = await getDoc(userRef);
    const p = snap.data() || {};
    currentUser.gamertag = p.gamertag || currentUser.gamertag;
    currentUser.uid = p.uid || "";
    currentUser.accountName = p.accountName || "";
    currentUser.lastChanged = p.lastChanged || {};

    document.getElementById("profile-initial").textContent = currentUser.gamertag[0].toUpperCase();
    document.getElementById("dropdown-gamertag").textContent = currentUser.gamertag;
    updateBottomNavProfile();
    syncPublicProfile();
    renderDashboard();
    renderHome();
    closeEditProfile();
    toast("Profile updated. Those fields are locked for 7 days.", "success");
  } catch(err){
    console.error(err);
    editError.textContent = err && err.code === "permission-denied"
      ? "You changed one of these fields recently. Try again once the 7 days are over."
      : "Couldn't save your changes. Check your connection and try again.";
  } finally {
    saveProfileBtn.disabled = false;
    resetEditConfirm();
  }
});

/* ===================== LOBBY RENDERING ===================== */
function renderLobbies(){
  const grid = document.getElementById("lobby-grid");
  grid.innerHTML = "";
  const emptyEl = document.getElementById("lobby-empty");
  emptyEl.textContent = LOBBIES.length ? "No lobbies match your search." : "No open lobbies right now. Check back soon.";
  emptyEl.classList.toggle("hidden", LOBBIES.length > 0);
  LOBBIES.forEach(lobby => {
    const pct = Math.round((lobby.players / lobby.max) * 100);
    const card = document.createElement("div");
    card.className = "lobby-card";
    card.setAttribute("data-reveal","");
    card.innerHTML = `
      <div class="lobby-cover" style="--c:${esc(lobby.color)}">${lobbyIconSvg(lobby.id)}</div>
      <p class="lobby-tag">${esc(lobby.tag)}</p>
      <h3>${esc(lobby.title)}</h3>
      <p class="desc">${esc(lobby.desc)}</p>
      <div class="lobby-meta">
        <div><span class="m-label">Entry</span><span class="m-value">$${lobby.fee.toFixed(2)}</span></div>
        <div><span class="m-label">Reward</span><span class="m-value mint">$${lobby.rewardMin}–$${lobby.rewardMax}</span></div>
      </div>
      <div>
        <div class="players-bar"><div class="players-bar-fill" style="width:${pct}%"></div></div>
        <p class="players-count">${lobby.players}/${lobby.max} players joined</p>
        <p class="players-count lobby-start">${startMs(lobby) ? "Starts " + fmtStart(startMs(lobby)) : "Start time to be announced"}</p>
      </div>
      <button class="btn btn-primary btn-block join-btn" data-lobby="${esc(lobby.id)}">Join lobby</button>
    `;
    grid.appendChild(card);

    // photo chosen by the admin (stored on the lobby), else optional images/lobbies/<lobby id>.jpg
    const cover = card.querySelector(".lobby-cover");
    if(lobby.image){
      cover.style.backgroundImage = `url("${lobby.image}")`;
      cover.classList.add("has-photo");
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      cover.style.backgroundImage = `url(images/lobbies/${lobby.id}.jpg)`;
      cover.classList.add("has-photo");
    };
    probe.src = `images/lobbies/${lobby.id}.jpg`;
  });

  grid.querySelectorAll(".join-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if(!currentUser){
        toast("Create a free account to join a lobby");
        openAuthModal("signup");
        return;
      }
      openJoinModal(btn.dataset.lobby);
    });
  });

  initScrollReveal();
  refreshLobbyButtons();
}

function renderLeaderboard(){
  const list = document.getElementById("leaderboard-list");
  list.innerHTML = "";
  LEADERBOARD.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.setAttribute("data-reveal","");
    row.innerHTML = `
      <span class="lb-rank">#${i+1}</span>
      <span class="lb-avatar" style="background:${p.color}">${p.name[0]}</span>
      <div class="lb-info">
        <p class="lb-name">${p.name}</p>
        <p class="lb-sub">${p.sub}</p>
      </div>
      <span class="lb-amount">$${p.amount.toFixed(2)}</span>
    `;
    list.appendChild(row);
  });
  initScrollReveal();
}

/* ===================== LOBBY TIMES, ENTRIES + ROOM CODES ===================== */
// Use the server's clock, not the phone's, so a wrong device clock can't make a lobby look "started".
let clockOffset = 0;
const nowMs = () => Date.now() + clockOffset;
async function syncClock(){
  try{
    const t0 = Date.now();
    const res = await fetch(location.pathname || "/", { method:"HEAD", cache:"no-store" });
    const t1 = Date.now();
    const d = res.headers.get("date");
    if(!d) return;
    const server = new Date(d).getTime() + (Number(res.headers.get("age")) || 0) * 1000;
    if(!Number.isNaN(server)) clockOffset = server + (t1 - t0) / 2 - t1;
  }catch(e){ /* keep the device clock */ }
}
const startMs = (o) => (o && o.startsAt && typeof o.startsAt.seconds === "number") ? o.startsAt.seconds * 1000 : null;
const fmtStart = (ms) => new Date(ms).toLocaleString([], { weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit" });
const safeImg = (l) => (l && typeof l.image === "string" && l.image.startsWith("data:image/")) ? l.image : "";
const coverBg = (l) => safeImg(l) ? `background-image:url('${safeImg(l)}');background-size:cover;background-position:center;` : "";
const coverIcon = (l, cls = "") => safeImg(l) ? "" : lobbyIconSvg(l.id, cls);

let myEntries = {};          // lobbyId -> entry the signed-in player paid for
let revealTimer = null;
const revealTry = {};        // lobbyId -> last time we tried to fetch the code

// small inline styles for the room-code popup
(function(){
  const st = document.createElement("style");
  st.textContent = ".px-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1.9rem;letter-spacing:.14em;text-align:center;padding:16px;margin:14px 0;border-radius:14px;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.4);color:#fff;word-break:break-all;user-select:all}.px-code-actions{display:flex;gap:10px}.px-code-actions .btn{flex:1}.lobby-start{margin-top:4px}";
  document.head.appendChild(st);
})();

function ensureCodeModal(){
  let ov = document.getElementById("code-modal-overlay");
  if(ov) return ov;
  ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.id = "code-modal-overlay";
  ov.innerHTML = `
    <div class="modal glass">
      <button class="icon-btn modal-close" id="code-modal-close" aria-label="Close">✕</button>
      <p class="eyebrow" id="code-modal-tag"></p>
      <h3 id="code-modal-title"></h3>
      <p class="sub" id="code-modal-body"></p>
      <div class="px-code hidden" id="code-modal-code"></div>
      <div class="px-code-actions">
        <button class="btn btn-primary hidden" id="code-modal-copy" type="button">Copy code</button>
        <button class="btn btn-primary" id="code-modal-ok" type="button">Got it</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.classList.remove("open");
  ov.querySelector("#code-modal-close").addEventListener("click", close);
  ov.querySelector("#code-modal-ok").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if(e.target === ov) close(); });
  ov.querySelector("#code-modal-copy").addEventListener("click", async () => {
    try{ await navigator.clipboard.writeText(document.getElementById("code-modal-code").textContent); toast("Room code copied"); }
    catch(e){ toast("Press and hold the code to copy it"); }
  });
  return ov;
}
function showCodeModal({ tag = "", title, body, code = "" }){
  const ov = ensureCodeModal();
  document.getElementById("code-modal-tag").textContent = tag;
  document.getElementById("code-modal-title").textContent = title;
  document.getElementById("code-modal-body").textContent = body;
  const codeEl = document.getElementById("code-modal-code");
  codeEl.textContent = code;
  codeEl.classList.toggle("hidden", !code);
  document.getElementById("code-modal-copy").classList.toggle("hidden", !code);
  ov.classList.add("open");
}

function lobbyState(l){
  const e = myEntries[l.id];
  const s = startMs(l) ?? startMs(e);
  const now = nowMs();
  if(e) return (s && now >= s) ? "code" : "entered";
  if(!s) return "notime";
  return now >= s ? "started" : "open";
}

function refreshLobbyButtons(){
  const labels = { open:"Join lobby", entered:"Entered ✓", code:"View room code", started:"Lobby started", notime:"Start time not set" };
  document.querySelectorAll("#lobby-grid .join-btn").forEach(btn => {
    const l = LOBBIES.find(x => x.id === btn.dataset.lobby);
    if(!l) return;
    const st = lobbyState(l);
    btn.textContent = labels[st];
    btn.disabled = (st === "started" || st === "notime");
  });
}

async function loadMyEntries(){
  myEntries = {};
  if(!currentUser) return;
  try{
    const snap = await getDocs(query(collection(db, "entries"), where("uid", "==", currentUser.id)));
    snap.forEach(d => { const e = d.data(); myEntries[e.lobbyId] = e; });
  }catch(err){ console.error(err); }
  refreshLobbyButtons();
  startRevealWatcher();
}

// Fetch the room code. Firestore rules only return it to a player who paid, and only after the start time (server clock).
async function revealCode(lobbyId, manual){
  const l = LOBBIES.find(x => x.id === lobbyId);
  const e = myEntries[lobbyId];
  const title = (l && l.title) || (e && e.title) || "Your lobby";
  try{
    const snap = await getDoc(doc(db, "roomCodes", lobbyId));
    if(snap.exists() && snap.data().code){
      showCodeModal({
        tag:"ROOM CODE", title, code: snap.data().code,
        body:"Enter this code in Call of Duty: Mobile to join the room. It is tied to your paid entry, so don't share it."
      });
      return true;
    }
    if(manual) showCodeModal({ tag:"ROOM CODE", title, body:"The match has started but the room code hasn't been posted yet. You'll get a notification the moment it's up." });
  }catch(err){
    if(manual) showCodeModal({ tag:"ROOM CODE", title, body:"The room code isn't available yet. Try again in a moment." });
  }
  return false;
}

function showEntryInfo(l){
  const s = startMs(l) ?? startMs(myEntries[l.id]);
  showCodeModal({
    tag:"YOU'RE IN", title:l.title,
    body: s ? `Your entry is paid. The room code will appear here automatically at ${fmtStart(s)}. Keep Praxio open or come back then.`
            : "Your entry is paid. The room code will appear here when the match starts."
  });
}

function startRevealWatcher(){
  stopRevealWatcher();
  revealTimer = setInterval(checkReveals, 5000);
  checkReveals();
}
function stopRevealWatcher(){ if(revealTimer){ clearInterval(revealTimer); revealTimer = null; } }

async function checkReveals(){
  if(!currentUser) return;
  refreshLobbyButtons();
  const now = nowMs();
  for(const id of Object.keys(myEntries)){
    const e = myEntries[id];
    const l = LOBBIES.find(x => x.id === id);
    const s = startMs(l) ?? startMs(e);
    if(!s || now < s || now - s > 12 * 3600 * 1000) continue;
    const seenKey = `px_code_seen_${currentUser.id}_${id}`;
    let seen = false;
    try{ seen = !!localStorage.getItem(seenKey); }catch(_){}
    if(seen) continue;
    if(now - (revealTry[id] || 0) < 15000) continue;
    revealTry[id] = now;
    if(await revealCode(id, false)){
      try{ localStorage.setItem(seenKey, "1"); }catch(_){}
      toast("Your room code is ready!");
    }
  }
}

/* ===================== JOIN LOBBY MODAL ===================== */
let activeLobbyData = null;
const joinOverlay = document.getElementById("join-modal-overlay");

function openJoinModal(lobbyId){
  activeLobbyData = LOBBIES.find(l => l.id === lobbyId);
  if(!activeLobbyData){ toast("That lobby is no longer open.", "error"); return; }
  const lobbyNow = activeLobbyData;
  const st = lobbyState(lobbyNow);
  if(st === "entered"){ showEntryInfo(lobbyNow); return; }
  if(st === "code"){ revealCode(lobbyNow.id, true); return; }
  if(st === "started"){ toast(`This lobby started at ${fmtStart(startMs(lobbyNow))}.`); return; }
  if(st === "notime"){ toast("The start time for this lobby hasn't been set yet."); return; }
  document.getElementById("join-modal-tag").textContent = activeLobbyData.tag;
  document.getElementById("join-modal-title").textContent = activeLobbyData.title;
  document.getElementById("join-modal-desc").textContent = `${activeLobbyData.desc} Starts ${fmtStart(startMs(activeLobbyData))}. The room code is shown to paid players when the match starts.`;
  document.getElementById("join-modal-fee").textContent = `$${activeLobbyData.fee.toFixed(2)}`;
  document.getElementById("join-modal-reward").textContent = `$${activeLobbyData.rewardMin}–$${activeLobbyData.rewardMax}`;
  document.getElementById("join-modal-players").textContent = `${activeLobbyData.players}/${activeLobbyData.max}`;
  document.getElementById("join-modal-error").textContent = "";
  joinOverlay.classList.add("open");
}

function closeModal(overlayEl){ overlayEl.classList.remove("open"); }

document.querySelectorAll("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", () => {
    closeModal(document.getElementById("join-modal-overlay"));
    closeModal(document.getElementById("match-modal-overlay"));
  });
});

let joining = false;
document.getElementById("confirm-join-btn").addEventListener("click", async () => {
  if(joining) return;
  const lobby = activeLobbyData;
  const errorEl = document.getElementById("join-modal-error");
  const btn = document.getElementById("confirm-join-btn");
  if(!lobby || !currentUser) return;
  const wallet = getWallet(currentUser.email);
  const s = startMs(lobby);

  if(myEntries[lobby.id]){ errorEl.textContent = "You've already joined this lobby."; return; }
  if(!s || nowMs() >= s){ errorEl.textContent = s ? `This lobby started at ${fmtStart(s)}.` : "This lobby has no start time yet."; return; }
  if(lobby.players >= lobby.max){ errorEl.textContent = "This lobby is full."; return; }
  if(wallet.balance < lobby.fee){
    errorEl.textContent = "Insufficient balance. Top up your wallet to join this lobby.";
    return;
  }

  joining = true; btn.disabled = true; errorEl.textContent = "";
  const newWallet = {
    ...wallet,
    balance: wallet.balance - lobby.fee,
    activeLobby: lobby.title,
    history: [...(wallet.history || []), { name:`Entry fee · ${lobby.title}`, amount: lobby.fee, date: new Date().toISOString(), type:"neg" }]
  };
  try{
    // One atomic write: pay the fee, record the paid entry, and take a slot in the lobby.
    const batch = writeBatch(db);
    batch.set(doc(db, "wallets", currentUser.id), newWallet);
    batch.set(doc(db, "entries", `${lobby.id}_${currentUser.id}`), {
      lobbyId: lobby.id, uid: currentUser.id, title: lobby.title, fee: lobby.fee,
      startsAt: lobby.startsAt, paidAt: serverTimestamp()
    });
    batch.update(doc(db, "lobbies", lobby.id), { players: increment(1) });
    await batch.commit();

    walletCache = newWallet;
    myEntries[lobby.id] = { lobbyId: lobby.id, uid: currentUser.id, title: lobby.title, fee: lobby.fee, startsAt: lobby.startsAt };
    lobby.players += 1;
    renderWallet();
    renderLobbies();
    startRevealWatcher();
    closeModal(joinOverlay);
    toast("You're in! The room code appears here at start time.");
    showEntryInfo(lobby);
  }catch(err){
    console.error(err);
    errorEl.textContent = "Couldn't join. The lobby may be full, already started, or your balance changed. Refresh and try again.";
  }finally{
    joining = false; btn.disabled = false;
  }
});

/* ===================== MATCH SIMULATION ===================== */
function runMatchSimulation(lobby){
  const matchOverlay = document.getElementById("match-modal-overlay");
  const loadingEl = document.getElementById("match-loading");
  const resultEl = document.getElementById("match-result");
  loadingEl.hidden = false;
  resultEl.hidden = true;
  matchOverlay.classList.add("open");

  setTimeout(() => {
    const wallet = getWallet(currentUser.email);
    wallet.matches += 1;

    const didWin = Math.random() < 0.55;
    const icon = document.getElementById("result-icon");
    const title = document.getElementById("result-title");
    const desc = document.getElementById("result-desc");
    const amountEl = document.getElementById("result-amount");

    if(didWin){
      const reward = +(lobby.rewardMin + Math.random() * (lobby.rewardMax - lobby.rewardMin)).toFixed(2);
      wallet.wins += 1;
      wallet.balance += reward;
      wallet.history.push({ name:`Reward · ${lobby.title}`, amount: reward, date: new Date().toISOString(), type:"pos" });
      icon.textContent = "🏆";
      title.textContent = "Victory!";
      desc.textContent = `You placed in the money in ${lobby.title}.`;
      amountEl.textContent = `+$${reward.toFixed(2)}`;
      amountEl.className = "result-amount pos";
    } else {
      icon.textContent = "🎮";
      title.textContent = "So close!";
      desc.textContent = `You didn't place this time in ${lobby.title}. Your entry fee stays in the prize pool.`;
      amountEl.textContent = `$0.00`;
      amountEl.className = "result-amount neg";
    }

    wallet.activeLobby = null;
    saveWallet(currentUser.email, wallet);
    renderWallet();

    loadingEl.hidden = true;
    resultEl.hidden = false;
  }, 2400);
}

/* ===================== WALLET DRAWER ===================== */
const drawer = document.getElementById("wallet-drawer");
const drawerOverlay = document.getElementById("drawer-overlay");
function openDrawer(){ drawer.classList.add("open"); drawerOverlay.classList.add("open"); }
function closeDrawer(){ drawer.classList.remove("open"); drawerOverlay.classList.remove("open"); }
["open-wallet","open-wallet-2","open-wallet-mobile"].forEach(id => {
  document.getElementById(id).addEventListener("click", openDrawer);
});
document.getElementById("close-wallet").addEventListener("click", closeDrawer);
drawerOverlay.addEventListener("click", closeDrawer);

/* ===================== USER DASHBOARD ===================== */
const RANK_TITLES = ["Rookie","Operator","Veteran","Elite","Legend"];
const money = (n) => `$${n.toFixed(2)}`;

function renderDashboard(){
  if(!currentUser) return;
  const wallet = getWallet(currentUser.email);
  if(!wallet) return;
  const history = wallet.history || [];

  const hour = new Date().getHours();
  document.getElementById("dash-greeting").textContent =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  document.getElementById("dash-name").textContent = currentUser.gamertag;
  const avatarEl = document.getElementById("dash-avatar");
  if(currentUser.avatar){
    avatarEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = currentUser.avatar; img.alt = "";
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = currentUser.gamertag[0].toUpperCase();
  }

  const earned = history
    .filter(h => h.type === "pos" && h.name !== "Welcome bonus" && h.name !== "Deposit")
    .reduce((s,h) => s + h.amount, 0);
  const spent = history.filter(h => h.type === "neg").reduce((s,h) => s + h.amount, 0);
  const net = earned - spent;
  const winRate = wallet.matches ? Math.round((wallet.wins / wallet.matches) * 100) : 0;

  document.getElementById("dash-balance").textContent = money(wallet.balance);
  const remaining = WITHDRAW_MIN - wallet.balance;
  document.getElementById("dash-withdraw-note").textContent =
    remaining > 0 ? `${money(remaining)} more to withdraw` : "Ready to withdraw";
  document.getElementById("dash-earned").textContent = money(earned);
  document.getElementById("dash-net").textContent = `Net ${net < 0 ? "-" : "+"}${money(Math.abs(net))}`;
  document.getElementById("dash-matches").textContent = wallet.matches;
  document.getElementById("dash-wins").textContent = `${wallet.wins} ${wallet.wins === 1 ? "win" : "wins"}`;
  document.getElementById("dash-winrate").textContent = `${winRate}%`;
  document.getElementById("dash-winrate-bar").style.width = `${winRate}%`;

  const days = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
    days.push({ date:d, total:0 });
  }
  history.forEach(h => {
    if(h.type !== "pos" || h.name === "Welcome bonus" || h.name === "Deposit") return;
    const hd = new Date(h.date); hd.setHours(0,0,0,0);
    const slot = days.find(d => d.date.getTime() === hd.getTime());
    if(slot) slot.total += h.amount;
  });
  const weekTotal = days.reduce((s,d) => s + d.total, 0);
  const maxDay = Math.max(...days.map(d => d.total), 1);
  document.getElementById("dash-week-total").textContent = `${money(weekTotal)} this week`;
  const chart = document.getElementById("dash-chart");
  chart.innerHTML = "";
  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "chart-col";
    const h = d.total ? Math.max(10, Math.round((d.total / maxDay) * 110)) : 4;
    col.innerHTML = `
      <span class="chart-val">${d.total ? money(d.total) : ""}</span>
      <div class="chart-bar ${d.total ? "" : "empty"} ${i === 6 ? "today" : ""}" style="height:${h}px" title="${d.date.toLocaleDateString()}: ${money(d.total)}"></div>
      <span class="chart-day">${d.date.toLocaleDateString([], { weekday:"short" })}</span>
    `;
    chart.appendChild(col);
  });

  const xp = wallet.matches * 15;
  const level = Math.floor(xp / 100) + 1;
  document.getElementById("dash-level").textContent = level;
  document.getElementById("dash-xp").textContent = xp;
  document.getElementById("dash-xp-bar").style.width = `${xp % 100}%`;
  document.getElementById("dash-xp-next").textContent = `${100 - (xp % 100)} XP to level ${level + 1}`;
  document.getElementById("dash-rank-title").textContent = RANK_TITLES[Math.min(level - 1, RANK_TITLES.length - 1)];

  document.getElementById("dash-active").classList.toggle("live", !!wallet.activeLobby);
  document.getElementById("dash-active-name").textContent = wallet.activeLobby || "No active lobby";
  document.getElementById("dash-active-sub").textContent = wallet.activeLobby ? "Match in progress…" : "Join one to start earning.";

  const rankEl = document.getElementById("dash-rank");
  const rankSub = document.getElementById("dash-rank-sub");
  if(earned <= 0){
    rankEl.textContent = "Unranked";
    rankSub.textContent = "Win a lobby to join the top earners.";
  } else {
    const pos = LEADERBOARD.filter(p => p.amount > earned).length + 1;
    rankEl.textContent = `#${pos}`;
    if(pos === 1){
      rankSub.textContent = "You're leading the top earners.";
    } else if(pos <= LEADERBOARD.length){
      rankSub.textContent = `${money(LEADERBOARD[pos-2].amount - earned)} behind #${pos-1}.`;
    } else {
      rankSub.textContent = `${money(LEADERBOARD[LEADERBOARD.length-1].amount - earned)} to reach the top ${LEADERBOARD.length}.`;
    }
  }

  document.getElementById("dash-p-name").textContent = currentUser.accountName || "Not set";
  document.getElementById("dash-p-tag").textContent = currentUser.gamertag;
  document.getElementById("dash-p-uid").textContent = currentUser.uid || "Not added";
  document.getElementById("dash-p-email").textContent = currentUser.email;

  const act = document.getElementById("dash-activity");
  act.innerHTML = "";
  if(history.length === 0){
    act.innerHTML = `<p class="tx-empty">No activity yet. Join a lobby to get started.</p>`;
  } else {
    [...history].reverse().slice(0, 5).forEach(tx => {
      const date = new Date(tx.date);
      const row = document.createElement("div");
      row.className = "tx-row";
      row.innerHTML = `
        <div>
          <p class="tx-name">${tx.name}</p>
          <p class="tx-date">${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</p>
        </div>
        <span class="tx-amount ${tx.type === 'pos' ? 'pos' : 'neg'}">${tx.type === 'pos' ? '+' : '-'}${money(Math.abs(tx.amount))}</span>
      `;
      act.appendChild(row);
    });
  }
}

document.getElementById("dash-open-wallet").addEventListener("click", openDrawer);
document.getElementById("dash-view-all").addEventListener("click", openDrawer);

/* ===================== HOME (signed-in) ===================== */
const HOME_SLIDES = [
  { l1:"Skill meets", l2:"Rewards", text:"Play matches. Prove your skills. Earn rewards.", cta:"Find a Match", go:"search", mood:"purple" },
  { l1:"Win. Earn.", l2:"Repeat.", text:"Finish in the money and the reward lands in your wallet.", cta:"Join a Lobby", go:"search", mood:"mint" },
  { l1:"Top up &", l2:"Play", text:"Add funds in seconds and jump straight into a live lobby.", cta:"Deposit", go:"deposit", mood:"gold" }
];
const getUpcoming = () => {
  const now = nowMs();
  const timed = LOBBIES.filter(l => startMs(l) && startMs(l) > now).sort((x, y) => startMs(x) - startMs(y));
  return (timed.length ? timed : LOBBIES).slice(0, 2).map(l => ({
    id:l.id,
    badge:(l.badge || (l.tag || "").split(/[ ·]/)[0].slice(0, 3)).toUpperCase(),
    when: startMs(l) ? fmtStart(startMs(l)) : "Time to be announced"
  }));
};
const ICON_USERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.4-3.6 3.1-5.8 6.5-5.8s6.1 2.2 6.5 5.8"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const ICON_CROWN = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/></svg>`;

function homeGo(go){
  if(go === "deposit") openDeposit();
  else showView(go);
}
document.querySelectorAll("[data-home-go]").forEach(b => {
  b.addEventListener("click", () => homeGo(b.dataset.homeGo));
});

// rotating banner
let bannerIndex = 0;
function setBanner(i){
  bannerIndex = i;
  document.getElementById("home-banner").dataset.slide = i;
  document.querySelectorAll(".banner-slide").forEach((s, n) => s.classList.toggle("active", n === i));
  document.querySelectorAll(".banner-dot").forEach((d, n) => d.classList.toggle("active", n === i));
}
function buildBanner(){
  const slidesEl = document.getElementById("banner-slides");
  const dotsEl = document.getElementById("banner-dots");
  HOME_SLIDES.forEach((s, i) => {
    const slide = document.createElement("div");
    slide.className = `banner-slide mood-${s.mood}`;
    slide.innerHTML = `
      <p class="bs-l1">${s.l1}</p>
      <p class="bs-l2">${s.l2}</p>
      <p class="bs-text">${s.text}</p>
      <button class="btn btn-primary">${s.cta} <span class="arrow">→</span></button>`;
    slide.querySelector("button").addEventListener("click", () => homeGo(s.go));
    slidesEl.appendChild(slide);

    const dot = document.createElement("button");
    dot.className = "banner-dot";
    dot.setAttribute("aria-label", `Slide ${i + 1}`);
    dot.addEventListener("click", () => setBanner(i));
    dotsEl.appendChild(dot);
  });
  setBanner(0);
  setInterval(() => {
    if(currentUser && currentView === "home") setBanner((bannerIndex + 1) % HOME_SLIDES.length);
  }, 5000);
}
buildBanner();

// use images/banner.jpg as the banner background if the file exists
(function(){
  const probe = new Image();
  probe.onload = () => document.getElementById("home-banner").classList.add("has-image");
  probe.src = "images/banner.jpg";
})();

function renderHome(){
  if(!currentUser) return;
  const wallet = getWallet();
  if(!wallet) return;

  document.getElementById("home-name").textContent = currentUser.gamertag;
  document.getElementById("home-verified").classList.toggle("hidden", !currentUser.uid);

  const earned = (wallet.history || [])
    .filter(h => h.type === "pos" && h.name !== "Welcome bonus" && h.name !== "Deposit")
    .reduce((s, h) => s + h.amount, 0);
  document.getElementById("home-matches").textContent = wallet.matches;
  document.getElementById("home-wins").textContent = wallet.wins;
  document.getElementById("home-rewards").textContent = money(earned);

  const upList = document.getElementById("home-upcoming");
  upList.innerHTML = "";
  getUpcoming().forEach(u => {
    const l = LOBBIES.find(x => x.id === u.id);
    if(!l) return;
    const row = document.createElement("div");
    row.className = "up-row";
    row.innerHTML = `
      <div class="up-thumb" style="--c:${esc(l.color)};${coverBg(l)}">
        ${coverIcon(l, "up-icon")}
        <span class="up-badge">${u.badge}</span>
      </div>
      <div class="up-info">
        <p class="up-title">${esc(l.title)}</p>
        <p class="up-meta">${ICON_USERS} ${l.players}/${l.max}</p>
        <p class="up-meta"><span class="coin"></span>Top reward <b>$${l.rewardMax}</b> · Entry ${money(l.fee)}</p>
        <p class="up-meta">${ICON_CLOCK} ${u.when}</p>
      </div>
      <button class="btn btn-primary up-join">Join <span class="arrow">→</span></button>`;
    row.querySelector(".up-join").addEventListener("click", () => openJoinModal(l.id));
    upList.appendChild(row);
  });

  const topList = document.getElementById("home-top");
  topList.innerHTML = "";
  LEADERBOARD.slice(0, 3).forEach((p, i) => {
    const wins = parseInt((p.sub.match(/(\d+) wins/) || [])[1] || 0, 10);
    const row = document.createElement("div");
    row.className = "top-row";
    row.innerHTML = `
      <span class="top-rank">${i + 1}</span>
      <span class="crown c${i + 1}">${ICON_CROWN}</span>
      <span class="top-avatar" style="background:${p.color}">${p.name[0]}</span>
      <div class="top-info">
        <p class="top-name">${p.name}</p>
        <p class="top-sub">Wins: ${wins} • ${money(p.amount)}</p>
      </div>
      <span class="top-chev">›</span>`;
    topList.appendChild(row);
  });
}

/* ===================== CHAT (Firestore, one-to-one) ===================== */
// Each conversation lives at chats/{uidA_uidB} (the two uids sorted). Only those two people can read it.
// Players find each other through publicProfiles (gamer tag + avatar).
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const ICON_SQUAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><circle cx="5.5" cy="10" r="2.2"/><circle cx="18.5" cy="10" r="2.2"/><path d="M6.5 19c.5-3 2.7-4.8 5.5-4.8s5 1.8 5.5 4.8M1.5 18c.3-2.2 1.6-3.6 3.2-4M22.5 18c-.3-2.2-1.6-3.6-3.2-4"/></svg>`;
const ICON_TICK = `<svg class="cm-tick" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m2 6.5 2.6 2.6L10 3.4"/></svg>`;
const AV_COLORS = ["#8B5CF6", "#EC4899", "#F97316", "#22D3EE", "#34D399", "#A855F7"];
const colorFor = (name) => {
  let h = 0;
  for(const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
};
const clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
const dayDiff = (ts) => {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((day(new Date()) - day(new Date(ts))) / 86400000);
};
const dayLabel = (ts) => {
  const diff = dayDiff(ts);
  if(diff <= 0) return "Today";
  if(diff === 1) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" });
};
function formatChatTime(ts){
  const diff = dayDiff(ts);
  if(diff <= 0) return clockTime(ts);
  if(diff === 1) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { month:"short", day:"numeric" });
}

let chats = [];            // conversations that exist in Firestore
let draftChat = null;      // a chat you opened but haven't sent a message in yet
let chatFilter = "all";
let activeChatId = null;
let activeMsgs = [];
let chatsUnsub = null;
let msgsUnsub = null;
let chatsError = "";
const profileCache = new Map();   // uid -> { gamertag, avatar }

const chatIdFor = (a, b) => [a, b].sort().join("_");
const findChat = (id) => chats.find(c => c.id === id) || (draftChat && draftChat.id === id ? draftChat : null);

/* ---- public profile (so other players can find you by gamer tag) ---- */
async function syncPublicProfile(){
  if(!currentUser) return;
  try{
    await setDoc(doc(db, "publicProfiles", currentUser.id), {
      gamertag: currentUser.gamertag,
      gamertagLower: currentUser.gamertag.toLowerCase(),
      avatar: currentUser.avatar || null
    }, { merge:true });
  }catch(err){ console.warn("Couldn't sync public profile", err); }
}

async function getProfile(uid){
  if(profileCache.has(uid)) return profileCache.get(uid);
  try{
    const snap = await getDoc(doc(db, "publicProfiles", uid));
    const p = snap.exists()
      ? { gamertag: snap.data().gamertag || "Player", avatar: snap.data().avatar || null }
      : { gamertag:"Player", avatar:null };
    profileCache.set(uid, p);
    return p;
  }catch(err){
    console.warn(err);
    return { gamertag:"Player", avatar:null };
  }
}

/* ---- avatars ---- */
function avatarHtml(name, avatar){
  const face = avatar
    ? `<span class="ca-face has-img"><img src="${esc(avatar)}" alt=""></span>`
    : `<span class="ca-face" style="--c:${colorFor(name)}">${esc(name[0].toUpperCase())}</span>`;
  return `<span class="ca">${face}</span>`;
}
function miniAvatar(name, avatar){
  return avatar
    ? `<span class="cm-av"><img src="${esc(avatar)}" alt=""></span>`
    : `<span class="cm-av" style="--c:${colorFor(name)}">${esc(name[0].toUpperCase())}</span>`;
}

/* ---- live data ---- */
function stopChats(){
  if(chatsUnsub){ chatsUnsub(); chatsUnsub = null; }
  if(msgsUnsub){ msgsUnsub(); msgsUnsub = null; }
  chats = []; draftChat = null; activeChatId = null; activeMsgs = []; chatsError = "";
  profileCache.clear();
  updateChatBadge();
}

function startChats(){
  stopChats();
  if(!currentUser) return;
  const q = query(collection(db, "chats"), where("members", "array-contains", currentUser.id));
  chatsUnsub = onSnapshot(q, async (snap) => {
    chatsError = "";
    const rows = snap.docs.map(d => ({ id:d.id, ...d.data({ serverTimestamps:"estimate" }) }));
    rows.forEach(r => { r.otherUid = (r.members || []).find(m => m !== currentUser.id); });
    await Promise.all(rows.filter(r => r.otherUid).map(r => getProfile(r.otherUid)));
    chats = rows.filter(r => r.otherUid).map(r => {
      const p = profileCache.get(r.otherUid) || { gamertag:"Player", avatar:null };
      return {
        id: r.id, otherUid: r.otherUid, name: p.gamertag, avatar: p.avatar,
        lastText: r.lastText || "", lastFrom: r.lastFrom || "", lastAt: tsToMs(r.lastAt),
        unread: (r.unread && r.unread[currentUser.id]) || 0
      };
    });
    if(draftChat && chats.some(c => c.id === draftChat.id)) draftChat = null;
    renderChatList();
    if(activeChatId) renderThread();
  }, (err) => {
    console.error(err);
    chatsError = err && err.code === "permission-denied"
      ? "Chat isn't switched on yet. Publish the latest Firestore rules, then reload."
      : "Couldn't load your messages. Check your connection.";
    renderChatList();
  });
}

function updateChatBadge(){
  const total = chats.reduce((s, c) => s + (c.unread || 0), 0);
  const badge = document.getElementById("bn-chat-badge");
  badge.textContent = total > 99 ? "99+" : total;
  badge.classList.toggle("hidden", total === 0);
}

/* ---- conversation list ---- */
function renderChatList(){
  if(!currentUser) return;
  const q = document.getElementById("chat-search").value.trim().toLowerCase();
  const totalUnread = chats.reduce((s, c) => s + (c.unread || 0), 0);
  const cf = document.getElementById("cf-all");
  cf.textContent = totalUnread;
  cf.classList.toggle("hidden", totalUnread === 0);
  updateChatBadge();

  const list = document.getElementById("chat-list");
  if(chatsError){ list.innerHTML = `<p class="chat-empty">${esc(chatsError)}</p>`; return; }

  const rows = chats
    .filter(c => chatFilter === "all" || c.unread > 0)
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.lastText.toLowerCase().includes(q))
    .sort((a, b) => b.lastAt - a.lastAt);

  list.innerHTML = "";
  if(!rows.length){
    list.innerHTML = `<p class="chat-empty">${
      chats.length ? "No conversations found." : "No messages yet. Tap the pencil to start a chat with another player."
    }</p>`;
    return;
  }
  rows.forEach(c => {
    const preview = !c.lastText ? "Say hi 👋" : (c.lastFrom === currentUser.id ? `You: ${c.lastText}` : c.lastText);
    const row = document.createElement("button");
    row.className = "chat-row";
    row.innerHTML = `
      ${avatarHtml(c.name, c.avatar)}
      <span class="chat-main">
        <span class="chat-name">${esc(c.name)}</span>
        <span class="chat-preview">${esc(preview)}</span>
      </span>
      <span class="chat-meta">
        <span class="chat-time">${c.lastAt ? formatChatTime(c.lastAt) : ""}</span>
        ${c.unread ? `<span class="chat-badge">${c.unread}</span>` : ""}
      </span>`;
    row.addEventListener("click", () => openThread(c.id));
    list.appendChild(row);
  });
}

function showChatList(){
  if(msgsUnsub){ msgsUnsub(); msgsUnsub = null; }
  activeChatId = null;
  activeMsgs = [];
  document.getElementById("chat-thread-screen").classList.add("hidden");
  document.getElementById("chat-list-screen").classList.remove("hidden");
  renderChatList();
}

/* ---- one conversation ---- */
function renderThread(){
  const c = findChat(activeChatId);
  if(!c) return;
  document.getElementById("thread-avatar").innerHTML = avatarHtml(c.name, c.avatar);
  document.getElementById("thread-name").textContent = c.name;

  const box = document.getElementById("thread-msgs");
  box.innerHTML = activeMsgs.length ? "" : `<p class="chat-empty">No messages yet. Say hi to ${esc(c.name)} 👋</p>`;

  let lastDay = "";
  activeMsgs.forEach(m => {
    const ts = tsToMs(m.createdAt) || Date.now();
    const dayKey = new Date(ts).toDateString();
    if(dayKey !== lastDay){
      lastDay = dayKey;
      box.insertAdjacentHTML("beforeend", `<div class="day-divider"><span>${dayLabel(ts)}</span></div>`);
    }
    const mine = m.from === currentUser.id;

    if(m.type === "invite"){
      const wrap = document.createElement("div");
      wrap.className = `invite-wrap ${mine ? "me" : "them"}`;
      const who = mine ? `You invited ${esc(c.name)} to` : `${esc(c.name)} invited you to`;
      const action = mine
        ? `<p class="invite-note">${m.joined ? "Joined ✓" : "Invite sent"}</p>`
        : `<button type="button" class="invite-btn" ${m.joined ? "disabled" : ""}>${m.joined ? "Joined ✓" : "Join"}</button>`;
      wrap.innerHTML = `
        <div class="invite-card">
          <span class="invite-icon">${ICON_SQUAD}</span>
          <div class="invite-body">
            <p class="invite-from">${who}</p>
            <p class="invite-title">${esc(m.squadName || "Squad")}</p>
            <p class="invite-meta">${esc(m.squadMembers || 1)} members • ${esc(m.game || "CODM")}</p>
            ${action}
          </div>
          <span class="invite-time">${clockTime(ts)}</span>
        </div>`;
      const btn = wrap.querySelector(".invite-btn");
      if(btn && !m.joined) btn.addEventListener("click", async () => {
        btn.disabled = true;
        try{
          await updateDoc(doc(db, "chats", c.id, "messages", m.id), { joined:true });
          toast(`You joined ${m.squadName}`, "success");
        }catch(err){
          console.error(err);
          btn.disabled = false;
          toast("Couldn't join. Try again.", "error");
        }
      });
      box.appendChild(wrap);
      return;
    }

    const row = document.createElement("div");
    row.className = `cm-row ${mine ? "me" : "them"}`;
    row.innerHTML = mine
      ? `<div class="cm-col">
           <span class="cm-bubble"><span class="cm-text">${esc(m.text)}</span><span class="cm-meta">${clockTime(ts)} ${m.pending ? "" : ICON_TICK}</span></span>
         </div>
         ${miniAvatar(currentUser.gamertag, currentUser.avatar)}`
      : `${miniAvatar(c.name, c.avatar)}
         <div class="cm-col">
           <span class="cm-name">${esc(c.name)}</span>
           <span class="cm-bubble"><span class="cm-text">${esc(m.text)}</span></span>
           <span class="cm-time">${clockTime(ts)}</span>
         </div>`;
    box.appendChild(row);
  });
  window.scrollTo({ top: document.body.scrollHeight, behavior:"instant" });
}

function closePops(){
  document.getElementById("plus-pop").classList.add("hidden");
  document.getElementById("emoji-tray").classList.add("hidden");
}

function openThread(id){
  const c = findChat(id);
  if(!c) return;
  if(msgsUnsub){ msgsUnsub(); msgsUnsub = null; }
  activeChatId = id;
  activeMsgs = [];
  closePops();
  document.getElementById("chat-list-screen").classList.add("hidden");
  document.getElementById("chat-thread-screen").classList.remove("hidden");
  renderThread();

  const q = query(collection(db, "chats", id, "messages"), orderBy("createdAt", "desc"), limit(100));
  msgsUnsub = onSnapshot(q, (snap) => {
    activeMsgs = snap.docs
      .map(d => ({ id:d.id, pending:d.metadata.hasPendingWrites, ...d.data({ serverTimestamps:"estimate" }) }))
      .reverse();
    renderThread();
    const cur = findChat(id);
    if(cur && cur.unread > 0){
      updateDoc(doc(db, "chats", id), { [`unread.${currentUser.id}`]: 0 }).catch(() => {});
    }
  }, (err) => {
    console.error(err);
    toast("Couldn't load this conversation.", "error");
  });
}

async function sendMessage(fields, preview){
  const c = findChat(activeChatId);
  if(!c || !currentUser) return;
  const me = currentUser.id;
  try{
    const batch = writeBatch(db);
    batch.set(doc(db, "chats", c.id), {
      members: [me, c.otherUid].sort(),
      lastText: preview,
      lastFrom: me,
      lastAt: serverTimestamp(),
      unread: { [c.otherUid]: increment(1) }
    }, { merge:true });
    batch.set(doc(collection(db, "chats", c.id, "messages")), {
      from: me,
      createdAt: serverTimestamp(),
      ...fields
    });
    await batch.commit();
  }catch(err){
    console.error(err);
    toast(err && err.code === "permission-denied"
      ? "Couldn't send. Publish the latest Firestore rules first."
      : "Couldn't send your message.", "error");
  }
}

document.getElementById("thread-back").addEventListener("click", () => {
  showChatList();
  window.scrollTo({ top:0, behavior:"instant" });
});

document.getElementById("thread-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("thread-input");
  const text = input.value.trim();
  if(!text) return;
  input.value = "";
  sendMessage({ type:"text", text }, text.slice(0, 120));
});

/* "+" menu and emoji tray in the message bar */
const plusPop = document.getElementById("plus-pop");
const emojiTray = document.getElementById("emoji-tray");
["🔥", "😂", "👍", "🎮", "👀", "💯", "😎", "🏆"].forEach(em => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = em;
  b.addEventListener("click", () => {
    const input = document.getElementById("thread-input");
    input.value += em;
    input.focus();
  });
  emojiTray.appendChild(b);
});
document.getElementById("thread-plus").addEventListener("click", (e) => {
  e.stopPropagation();
  emojiTray.classList.add("hidden");
  plusPop.classList.toggle("hidden");
});
document.getElementById("thread-emoji").addEventListener("click", (e) => {
  e.stopPropagation();
  plusPop.classList.add("hidden");
  emojiTray.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if(!e.target.closest("#plus-pop, #emoji-tray")) closePops();
});
document.getElementById("pop-invite").addEventListener("click", () => {
  closePops();
  sendMessage({ type:"invite", squadName:"PRAXIO Squad", squadMembers:4, game:"CODM", joined:false }, "Squad invite");
});

document.getElementById("chat-search").addEventListener("input", renderChatList);
document.querySelectorAll(".chat-filter").forEach(btn => {
  btn.addEventListener("click", () => {
    chatFilter = btn.dataset.filter;
    document.querySelectorAll(".chat-filter").forEach(b => b.classList.toggle("active", b === btn));
    renderChatList();
  });
});

/* ---- start a new chat by finding a player's gamer tag ---- */
const newChatOverlay = document.getElementById("newchat-overlay");
const newChatInput = document.getElementById("newchat-search");
const newChatList = document.getElementById("newchat-list");
let searchToken = 0;
let searchTimer = null;

function openNewChat(){
  newChatInput.value = "";
  newChatList.innerHTML = `<p class="chat-empty">Type a gamer tag to find a player.</p>`;
  newChatOverlay.classList.add("open");
  setTimeout(() => newChatInput.focus(), 250);
}
async function searchPlayers(term){
  const t = term.trim().toLowerCase();
  const token = ++searchToken;
  if(t.length < 2){
    newChatList.innerHTML = `<p class="chat-empty">Type at least 2 letters of a gamer tag.</p>`;
    return;
  }
  try{
    const q = query(
      collection(db, "publicProfiles"),
      where("gamertagLower", ">=", t),
      where("gamertagLower", "<=", t + ""),
      limit(10)
    );
    const snap = await getDocs(q);
    if(token !== searchToken) return;
    const people = snap.docs.filter(d => d.id !== currentUser.id);
    newChatList.innerHTML = people.length ? "" : `<p class="chat-empty">No players found for "${esc(term.trim())}".</p>`;
    people.forEach(d => {
      const p = d.data();
      const row = document.createElement("button");
      row.className = "newchat-row";
      row.innerHTML = `${avatarHtml(p.gamertag, p.avatar)}<span>${esc(p.gamertag)}</span>`;
      row.addEventListener("click", () => startChatWith(d.id, p));
      newChatList.appendChild(row);
    });
  }catch(err){
    console.error(err);
    if(token !== searchToken) return;
    newChatList.innerHTML = `<p class="chat-empty">${
      err && err.code === "permission-denied" ? "Player search isn't switched on yet. Publish the latest Firestore rules." : "Couldn't search right now."
    }</p>`;
  }
}
function startChatWith(uid, p){
  profileCache.set(uid, { gamertag: p.gamertag, avatar: p.avatar || null });
  const id = chatIdFor(currentUser.id, uid);
  if(!chats.some(c => c.id === id)){
    draftChat = { id, otherUid: uid, name: p.gamertag, avatar: p.avatar || null, lastText:"", lastFrom:"", lastAt:0, unread:0 };
  }
  newChatOverlay.classList.remove("open");
  if(currentView !== "chat") showView("chat");
  openThread(id);
}
newChatInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchPlayers(newChatInput.value), 250);
});
document.getElementById("chat-compose").addEventListener("click", openNewChat);
document.getElementById("close-newchat").addEventListener("click", () => newChatOverlay.classList.remove("open"));
newChatOverlay.addEventListener("click", (e) => { if(e.target === newChatOverlay) newChatOverlay.classList.remove("open"); });

/* ===================== SEARCH TAB (signed-in) ===================== */
const SR_GAME = "Call of Duty: Mobile";
const isTournament = (l) => /RANKED|GUNFIGHT|COMMUNITY|TOURNAMENT|BOUNTY/i.test(l.tag || "");
const srTournaments = () => LOBBIES.filter(isTournament);
const srMatches = () => LOBBIES.filter(l => !isTournament(l)).map(l => ({ id:l.id, badge:(l.badge || (l.tag || "").split(/[ ·]/)[0].slice(0, 3)).toUpperCase() }));
const SR_LIMIT = { all:{ players:4, tournaments:3, matches:3 }, one:{ players:20, tournaments:20, matches:20 } };
const IC_TROPHY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 21h8M10 17h4"/></svg>`;
const IC_PAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="19" height="11" rx="5"/><path d="M8 10.5v4M6 12.5h4"/><circle cx="15.5" cy="11.5" r=".9" fill="currentColor"/><circle cx="18" cy="14" r=".9" fill="currentColor"/></svg>`;

let srFilter = "all";
let srToken = 0;
let srTimer = null;
const srCounts = { players:0, tournaments:0, matches:0, games:0 };
const srInput = document.getElementById("sr-input");

const lobbyHay = (l) => `${l.title} ${l.tag} ${l.desc} codm ${SR_GAME}`.toLowerCase();
const srShows = (sec) => srFilter === "all" || srFilter === sec;
const srMax = (sec) => (srFilter === "all" ? SR_LIMIT.all : SR_LIMIT.one)[sec];

function srUpdateEmpty(){
  const q = srInput.value.trim();
  const any = Object.values(srCounts).some(n => n > 0);
  const el = document.getElementById("sr-empty");
  el.textContent = q ? `Nothing found for "${q}".` : "Nothing to show yet.";
  el.classList.toggle("hidden", any);
}

function srSection(sec, count, visible){
  srCounts[sec] = visible ? count : 0;
  document.getElementById(`sr-sec-${sec}`).classList.toggle("hidden", !visible || count === 0);
}

function renderSearch(){
  if(!currentUser) return;
  const q = srInput.value.trim().toLowerCase();
  document.getElementById("sr-clear").classList.toggle("hidden", !srInput.value);

  /* tournaments */
  const tList = document.getElementById("sr-tournaments");
  tList.innerHTML = "";
  const tRows = srTournaments().filter(l => (!q || lobbyHay(l).includes(q))).slice(0, srMax("tournaments"));
  tRows.forEach(l => {
    const row = document.createElement("div");
    row.className = "sr-row sr-wide";
    row.innerHTML = `
      <div class="sr-cover" style="--c:${esc(l.color)};${coverBg(l)}">${coverIcon(l)}</div>
      <div class="sr-info">
        <p class="sr-title">${esc(l.title)}</p>
        <p class="sr-meta">${IC_PAD} ${SR_GAME}</p>
        <p class="sr-meta gold">${IC_TROPHY} $${l.rewardMax} top reward · Entry ${money(l.fee)}</p>
        <p class="sr-meta">${ICON_USERS} ${l.players}/${l.max} players</p>
      </div>
      <button class="btn btn-primary sr-btn">Join <span class="arrow">→</span></button>`;
    row.querySelector(".sr-btn").addEventListener("click", () => openJoinModal(l.id));
    tList.appendChild(row);
  });
  srSection("tournaments", tRows.length, srShows("tournaments"));

  /* matches */
  const mList = document.getElementById("sr-matches");
  mList.innerHTML = "";
  const mRows = srMatches().map(m => ({ ...m, l: LOBBIES.find(l => l.id === m.id) })).filter(m => m.l && (!q || lobbyHay(m.l).includes(q))).slice(0, srMax("matches"));
  mRows.forEach(({ l, badge }) => {
    const row = document.createElement("div");
    row.className = "sr-row";
    row.innerHTML = `
      <div class="sr-cover sm" style="--c:${esc(l.color)};${coverBg(l)}">${coverIcon(l)}<span class="sr-badge">${badge}</span></div>
      <div class="sr-info">
        <p class="sr-title">${esc(l.title)}</p>
        <p class="sr-meta">${IC_PAD} ${SR_GAME}</p>
        <p class="sr-meta"><span class="live-dot"></span><b class="live">Open</b> • ${l.players}/${l.max}</p>
      </div>
      <button class="btn btn-primary sr-btn">View <span class="arrow">→</span></button>`;
    row.querySelector(".sr-btn").addEventListener("click", () => openJoinModal(l.id));
    mList.appendChild(row);
  });
  srSection("matches", mRows.length, srShows("matches"));

  /* games (only Call of Duty: Mobile has lobbies right now) */
  const gList = document.getElementById("sr-games");
  gList.innerHTML = "";
  const gameMatch = !q || `${SR_GAME} codm game`.toLowerCase().includes(q);
  if(gameMatch){
    const tile = document.createElement("button");
    tile.className = "sr-game";
    tile.innerHTML = `<span class="sg-art">${IC_PAD}</span><span class="sg-name">CODM</span><span class="sg-sub">${LOBBIES.length} lobbies</span>`;
    tile.addEventListener("click", () => setSrFilter("matches"));
    gList.appendChild(tile);
    const more = document.createElement("div");
    more.className = "sr-game soon";
    more.innerHTML = `<span class="sg-art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg></span><span class="sg-name">More</span><span class="sg-sub">Coming soon</span>`;
    gList.appendChild(more);
  }
  srSection("games", gameMatch ? 2 : 0, srShows("games"));

  renderSearchPlayers(q);
  srUpdateEmpty();
}

async function renderSearchPlayers(q){
  const list = document.getElementById("sr-players");
  const token = ++srToken;
  if(!srShows("players")){ srSection("players", 0, false); srUpdateEmpty(); return; }
  const max = srMax("players");
  try{
    const base = collection(db, "publicProfiles");
    const qry = q
      ? query(base, where("gamertagLower", ">=", q), where("gamertagLower", "<=", q + ""), limit(max + 1))
      : query(base, orderBy("gamertagLower"), limit(max + 1));
    const snap = await getDocs(qry);
    if(token !== srToken) return;
    const people = snap.docs.filter(d => d.id !== currentUser.id).slice(0, max);
    list.innerHTML = "";
    people.forEach(d => {
      const p = d.data();
      const row = document.createElement("div");
      row.className = "sr-row";
      row.innerHTML = `
        ${avatarHtml(p.gamertag, p.avatar)}
        <div class="sr-info">
          <p class="sr-title">${esc(p.gamertag)}</p>
          <p class="sr-meta">@${esc(p.gamertagLower)}</p>
          <p class="sr-meta">${ICON_CROWN} Praxio player</p>
        </div>
        <button class="btn btn-primary sr-btn">Message</button>`;
      row.querySelector(".sr-btn").addEventListener("click", () => startChatWith(d.id, p));
      list.appendChild(row);
    });
    srSection("players", people.length, true);
  }catch(err){
    console.error(err);
    if(token !== srToken) return;
    list.innerHTML = "";
    srSection("players", 0, true);
  }
  srUpdateEmpty();
}

srInput.addEventListener("input", () => {
  document.getElementById("sr-clear").classList.toggle("hidden", !srInput.value);
  clearTimeout(srTimer);
  srTimer = setTimeout(renderSearch, 220);
});
document.getElementById("sr-clear").addEventListener("click", () => {
  srInput.value = "";
  renderSearch();
  srInput.focus();
});
function setSrFilter(f){
  srFilter = f;
  document.querySelectorAll("#sr-chips .chat-filter").forEach(b => b.classList.toggle("active", b.dataset.sr === f));
  renderSearch();
}
document.querySelectorAll("#sr-chips .chat-filter").forEach(b => b.addEventListener("click", () => setSrFilter(b.dataset.sr)));
document.querySelectorAll("[data-sr-all]").forEach(b => b.addEventListener("click", () => setSrFilter(b.dataset.srAll)));

/* ===================== PROFILE DROPDOWN ===================== */
const profileBtn = document.getElementById("profile-btn");
const profileDropdown = document.getElementById("profile-dropdown");
profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileDropdown.classList.toggle("open");
});
document.addEventListener("click", () => profileDropdown.classList.remove("open"));

/* ===================== MOBILE NAV ===================== */
const navToggle = document.getElementById("nav-toggle");
const navLinks = document.getElementById("nav-links");
navToggle.addEventListener("click", () => {
  navToggle.classList.toggle("open");
  navLinks.classList.toggle("open");
});
navLinks.querySelectorAll(".nav-link:not(.nav-link-btn)").forEach(link => {
  link.addEventListener("click", () => { navToggle.classList.remove("open"); navLinks.classList.remove("open"); });
});

/* ===================== BOTTOM NAVIGATION ===================== */
const bottomNav = document.getElementById("bottom-nav");
const bnItems = bottomNav.querySelectorAll(".bn-item");
const lobbySearch = document.getElementById("lobby-search");
let currentView = "home";
// Signed-in users see one screen at a time: home, praxio (lobbies + leaderboard), chat or profile (dashboard)
function showView(name){
  if(!currentUser) return;
  currentView = name;
  document.querySelectorAll("[data-view]").forEach(el => {
    el.classList.toggle("view-hidden", !el.dataset.view.split(" ").includes(name));
  });
  setBottomNavActive(name);
  if(name === "chat") renderChatList();
  if(name === "search") renderSearch();
  window.scrollTo({ top:0, behavior:"instant" });
}

function setBottomNavActive(name){
  bnItems.forEach(b => b.classList.toggle("active", b.dataset.nav === name));
}

function updateBottomNavProfile(){
  const el = document.getElementById("bn-avatar");
  if(!el) return;
  // show the profile picture in the top navbar too
  const pb = document.getElementById("profile-btn");
  const pbText = document.getElementById("profile-initial");
  if(currentUser && currentUser.avatar){
    pb.style.backgroundImage = `url(${currentUser.avatar})`;
    pb.style.backgroundSize = "cover";
    pb.style.backgroundPosition = "center";
    pbText.style.visibility = "hidden";
  } else {
    pb.style.backgroundImage = "";
    pbText.style.visibility = "";
  }
  if(currentUser){
    if(currentUser.avatar){
      el.innerHTML = "";
      const img = document.createElement("img");
      img.src = currentUser.avatar; img.alt = "";
      el.appendChild(img);
    } else {
      el.textContent = currentUser.gamertag[0].toUpperCase();
    }
    el.classList.add("has-user");
  } else {
    el.classList.remove("has-user");
    el.innerHTML = `<svg class="bn-guest-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c.6-4.2 3.7-6.5 8-6.5s7.4 2.3 8 6.5"/></svg>`;
  }
}

function filterLobbies(){
  const q = lobbySearch.value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll("#lobby-grid .lobby-card").forEach(card => {
    const id = card.querySelector(".join-btn").dataset.lobby;
    const l = LOBBIES.find(x => x.id === id);
    const hay = `${l.title} ${l.tag} ${l.desc}`.toLowerCase();
    const show = !q || hay.includes(q);
    card.classList.toggle("hidden", !show);
    if(show) visible++;
  });
  document.getElementById("lobby-empty").classList.toggle("hidden", visible > 0);
}
lobbySearch.addEventListener("input", filterLobbies);

bnItems.forEach(btn => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.nav;
    switch(name){
      case "home":
        showView("home");
        break;
      case "search":
        showView("search");
        break;
      case "praxio":
        showView("praxio");
        break;
      case "chat":
        showView("chat");
        break;
      case "profile":
        showView("profile");
        break;
    }
    setBottomNavActive(name);
  });
});

// in-page links that switch screens (e.g. "All lobbies →" on the dashboard)
document.querySelectorAll("[data-go-view]").forEach(a => {
  a.addEventListener("click", (e) => { e.preventDefault(); showView(a.dataset.goView); });
});

/* ===================== NAVBAR SCROLL STYLE + HERO PARALLAX ===================== */
const navbar = document.getElementById("navbar");
const heroEl = document.querySelector(".hero");
let scrollTicking = false;
function updateScrollEffects(){
  scrollTicking = false;
  navbar.classList.toggle("scrolled", window.scrollY > 20);
  if(heroEl && heroEl.offsetHeight){
    const progress = Math.min(Math.max(window.scrollY / (heroEl.offsetHeight * 0.85), 0), 1);
    heroEl.style.setProperty("--scroll-progress", progress.toFixed(3));
  }
}
window.addEventListener("scroll", () => {
  if(!scrollTicking){ scrollTicking = true; requestAnimationFrame(updateScrollEffects); }
}, { passive:true });
updateScrollEffects();

/* ===================== SCROLL REVEAL ===================== */
let revealObserver;
function initScrollReveal(){
  if(!revealObserver){
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
  }
  document.querySelectorAll("[data-reveal]:not(.in-view)").forEach(el => revealObserver.observe(el));
}

/* ===================== INIT ===================== */
boot();

const appEl = document.getElementById("app");
const finishLoading = () => appEl.classList.remove("is-loading");
setTimeout(finishLoading, 4000);

onAuthStateChanged(auth, async (fbUser) => {
  if(signupInFlight) return;
  try{
    if(fbUser){
      await loadSession(fbUser);
      if(welcomeMsg){ afterSignIn(welcomeMsg); welcomeMsg = null; }
    } else {
      clearSession();
    }
  } catch(err){
    console.error(err);
    toast("Couldn't load your account. Check your connection.", "error");
  }
  finishLoading();
});