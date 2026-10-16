import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAetxFl59ofBAfPydw8KYHmGosKa61KVrM",
  authDomain: "praxio-20d28.firebaseapp.com",
  projectId: "praxio-20d28",
  storageBucket: "praxio-20d28.firebasestorage.app",
  messagingSenderId: "574210667229",
  appId: "1:574210667229:web:9d77bd3862a871714ea134",
  measurementId: "G-F7MJWFJVQ0"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

isSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});
