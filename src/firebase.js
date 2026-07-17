import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyC4LxOpnvYvCckH_OSm0mferD91ubWZ1xI",
  authDomain: "digital-shelf-34e22.firebaseapp.com",
  projectId: "digital-shelf-34e22",
  storageBucket: "digital-shelf-34e22.firebasestorage.app",
  messagingSenderId: "241469453078",
  appId: "1:241469453078:web:c4d15cbb5f7ee5f10bd637"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app); 
export const googleProvider = new GoogleAuthProvider();

