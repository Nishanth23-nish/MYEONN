import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDFpcYjnXpZt1v4AiTiSnqiJNlswtITPwY',
  authDomain: 'myeonn.firebaseapp.com',
  projectId: 'myeonn',
  storageBucket: 'myeonn.firebasestorage.app',
  messagingSenderId: '819764152545',
  appId: '1:819764152545:web:87d0261daf04808bd1cfa0',
  measurementId: 'G-KBM57XP150'
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

