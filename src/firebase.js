import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  // 캡처 화면에서 확인된 유저님의 진짜 API 키입니다.
  apiKey: "AIzaSyBIKNdOGuzCLr30Nh3VS5bKkIBKXhKn4BE",
  authDomain: "my-digital-library-aea5f.firebaseapp.com",
  projectId: "my-digital-library-aea5f",
  storageBucket: "my-digital-library-aea5f.firebasestorage.app",
  messagingSenderId: "999674499400",
  appId: "1:999674499400:web:90606eec2c735a921be37d",
  measurementId: "G-SF8NS1T6ET"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app); 
export const googleProvider = new GoogleAuthProvider();

