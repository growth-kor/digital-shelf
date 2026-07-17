import React, { useState, useEffect, useRef } from 'react';
import { db, storage, auth, googleProvider } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, getDocs, query, orderBy, where, doc, runTransaction, onSnapshot, deleteDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { Book as BookIcon, Plus, ChevronLeft, ChevronRight, Maximize2, X, ArrowRight, Upload, Trash2 } from 'lucide-react';
import HTMLFlipBook from 'react-pageflip';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// 관리자 및 지정된 친구 이메일 목록 (쉽게 여기에서 추가/삭제하여 관리할 수 있습니다)
// Whitelist of authorized emails (easy to manage by editing this array)
const AUTHORIZED_EMAILS = [
  'skateboard4335@gmail.com',
  'jeki4332@gmail.com'
];

const Page = React.forwardRef(({ pdfDoc, number }, ref) => {
  const canvasRef = useRef(null);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pdfDoc) return;
      try {
        const page = await pdfDoc.getPage(number);
        const vp = page.getViewport({ scale: 1.5 });
        const canvas = canvasRef.current;
        if (!canvas || !alive) return;
        canvas.height = vp.height; canvas.width = vp.width;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        if (alive) setRendered(true);
      } catch (e) { console.error(e); }
    })();
    return () => { alive = false; };
  }, [pdfDoc, number]);
  return (
    <div ref={ref} style={{ background: '#fff', width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      {!rendered && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#faf9f6' }}>
          <div className="page-spinner" />
        </div>
      )}
    </div>
  );
});

function LoadingOverlay() {
  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="book-anim">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="book-page-strip" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <p className="loading-label">OPENING ARCHIVE</p>
        <div className="loading-dots">
          <span style={{ animationDelay: '0s' }} />
          <span style={{ animationDelay: '0.2s' }} />
          <span style={{ animationDelay: '0.4s' }} />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [isCloudUser, setIsCloudUser] = useState(false);
  const [selectedBook, setSelectedBook] = useState(null);
  const [books, setBooks] = useState([]); // Cloud users' books
  const [localBooks, setLocalBooks] = useState([]); // Free users' books
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [isOpening, setIsOpening] = useState(false);
  const [globalUsage, setGlobalUsage] = useState(0);
  const [pageInput, setPageInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const bookRef = useRef(null);
  const fileInputRef = useRef(null);
  const LIMIT = 5 * 1024 * 1024 * 1024; // 5.00 GB

  useEffect(() => {
    const unsub1 = onAuthStateChanged(auth, u => {
      setUser(u);
      if (u) {
        const isAuthorized = AUTHORIZED_EMAILS.includes(u.email);
        setIsCloudUser(isAuthorized);
        if (isAuthorized) {
          fetchBooks(u.uid);
        } else {
          setBooks([]);
          setSelectedBook(null);
        }
      } else {
        setUser(null);
        setIsCloudUser(false);
        setBooks([]);
        setLocalBooks([]);
        setSelectedBook(null);
      }
    });

    const unsub2 = onSnapshot(doc(db, 'global_stats', 'storage'), d => {
      if (d.exists()) setGlobalUsage(d.data().totalBytes);
    });

    return () => { unsub1(); unsub2(); };
  }, []);

  const fetchBooks = async uid => {
    const q = query(collection(db, 'books'), where('userId', '==', uid), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    setBooks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  };

  useEffect(() => {
    if (!selectedBook) { setPdfDoc(null); return; }
    setIsOpening(true);
    pdfjsLib.getDocument({ url: selectedBook.url, cMapUrl: 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/', cMapPacked: true })
      .promise.then(pdf => { setPdfDoc(pdf); setTimeout(() => setIsOpening(false), 600); })
      .catch(err => {
        console.error("PDF 로드 에러:", err);
        alert("PDF 로드 실패 / Failed to load PDF: " + err.message);
        setIsOpening(false);
        setSelectedBook(null);
      });
  }, [selectedBook]);

  const handleJump = () => {
    const p = parseInt(pageInput);
    if (p > 0 && p <= pdfDoc?.numPages) {
      bookRef.current.pageFlip().turnToPage(p - 1);
      setPageInput('');
    } else {
      alert(`1 ~ ${pdfDoc?.numPages} 사이를 입력하세요 / Enter between 1 and ${pdfDoc?.numPages}`);
    }
  };

  const doUpload = async file => {
    if (!file || !user) return;
    if (!file.name.endsWith('.pdf')) {
      alert('PDF 파일만 등록 가능합니다. / Only PDF files can be loaded.');
      return;
    }
    
    // 파일 크기 제한 (모두에게 500MB 제한 적용)
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB
    if (file.size > MAX_SIZE) {
      alert('파일 크기가 500MB를 초과합니다. / File size exceeds 500MB.');
      return;
    }

    if (!isCloudUser) {
      // 무료 회원: 등록 개수 제한 체크 (최대 5권)
      if (localBooks.length >= 5) {
        alert('무료 회원은 최대 5권까지만 추가할 수 있습니다. / Free members can only add up to 5 books.');
        return;
      }
      
      const url = URL.createObjectURL(file);
      const newBook = {
        id: Date.now().toString(),
        title: file.name,
        size: file.size,
        url,
        file
      };
      setLocalBooks(prev => [...prev, newBook]);
      return;
    }

    // 유료 클라우드 회원: Firebase Storage 업로드 및 Firestore 기록
    setUploading(true); 
    setProgress(0);
    const sRef = ref(storage, `pdfs/${user.uid}/${Date.now()}_${file.name}`);
    const task = uploadBytesResumable(sRef, file);
    
    task.on('state_changed', 
      s => setProgress(Math.round(s.bytesTransferred / s.totalBytes * 100)),
      (err) => {
        console.error(err);
        alert('업로드 실패: ' + err.message);
        setUploading(false);
      },
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          await runTransaction(db, async t => {
            const sr = doc(db, 'global_stats', 'storage');
            const sd = await t.get(sr);
            t.set(sr, { totalBytes: (sd.exists() ? sd.data().totalBytes : 0) + file.size }, { merge: true });
            t.set(doc(collection(db, 'books')), { 
              title: file.name, 
              url, 
              userId: user.uid, 
              size: file.size, 
              createdAt: new Date() 
            });
          });
          setUploading(false); 
          fetchBooks(user.uid);
        } catch (e) {
          console.error(e);
          alert('데이터 저장 실패: ' + e.message);
          setUploading(false);
        }
      }
    );
  };

  const deleteBook = async (book, e) => {
    e.stopPropagation(); // 카드 클릭 이벤트 차단
    
    const confirmMsg = isCloudUser 
      ? '이 책을 서버에서 완전히 삭제하시겠습니까? / Are you sure you want to permanently delete this book from the server?' 
      : '선반에서 이 책을 빼시겠습니까? / Are you sure you want to remove this book from the shelf?';
      
    if (!confirm(confirmMsg)) return;

    if (!isCloudUser) {
      URL.revokeObjectURL(book.url);
      setLocalBooks(prev => prev.filter(b => b.id !== book.id));
      if (selectedBook?.id === book.id) {
        setSelectedBook(null);
      }
      return;
    }

    try {
      await deleteDoc(doc(db, 'books', book.id));
      
      const fileRef = ref(storage, book.url);
      await deleteObject(fileRef).catch(err => console.error("Storage delete fail:", err));

      await runTransaction(db, async t => {
        const sr = doc(db, 'global_stats', 'storage');
        const sd = await t.get(sr);
        if (sd.exists()) {
          const newSize = Math.max(0, sd.data().totalBytes - book.size);
          t.set(sr, { totalBytes: newSize }, { merge: true });
        }
      });

      fetchBooks(user.uid);
      if (selectedBook?.id === book.id) {
        setSelectedBook(null);
      }
    } catch (e) {
      console.error(e);
      alert('삭제 실패 / Deletion failed: ' + e.message);
    }
  };

  const displayBooks = isCloudUser ? books : localBooks;

  if (!user) return (
    <>
      <style>{css}</style>
      <div className="login-screen">
        <div className="login-grid-bg" />
        <div className="login-glow" />
        <div className="login-card">
          <div className="login-icon-wrap">
            <BookIcon size={28} color="#ffffff" strokeWidth={2.5} />
          </div>
          <h1 className="login-title">PDF<br />SHELF</h1>
          <p className="login-sub">YOUR PRIVATE CLOUD LIBRARY</p>
          <button className="login-btn" onClick={() => {
            signInWithPopup(auth, googleProvider)
              .catch(err => {
                console.error("로그인 에러:", err);
                alert("로그인 실패: " + err.message);
              });
          }}>
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    </>
  );

  if (!selectedBook) return (
    <>
      <style>{css}</style>
      <div className="shelf-screen"
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); doUpload(e.dataTransfer.files[0]); }}>
        {dragOver && <div className="drop-zone"><Upload size={48} /><p>DROP PDF HERE</p></div>}
        
        <header className="shelf-header">
          <h1 className="shelf-title">PDF SHELF</h1>
          <div className="shelf-header-right">
            <div className="user-chip">
              <img src={user.photoURL} className="user-avatar" alt="avatar" />
              <span className="user-name">{user.displayName?.split(' ')[0]}</span>
              <button className="logout-btn" onClick={() => signOut(auth)}>LOGOUT</button>
            </div>
            <button className="add-btn" onClick={() => fileInputRef.current?.click()}>
              <Plus size={18} strokeWidth={3} /> ADD PDF
            </button>
            <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden-input" onChange={e => doUpload(e.target.files[0])} />
          </div>
        </header>

        {/* Bilingual Info Card */}
        <div className="info-card">
          <div className="info-section">
            <div className="info-block">
              <h2>서비스 이용 안내</h2>
              <p>본 서비스는 학습용 PDF 파일을 플립북 형태로 감상하는 개인 서재 웹 프로그램입니다.</p>
              <p>구글 로그인 후 본인 소유의 PDF 문서를 업로드하여 자유롭게 읽으실 수 있습니다.</p>
              <p><strong>무료 회원 (로컬 리더)</strong>: 올린 파일은 서버에 저장되지 않고 브라우저에 임시로 로딩되어 즉시 동작합니다. 파일당 500MB 이하, 최대 5권까지 동시에 책장에 띄울 수 있습니다.</p>
              <p><strong>유료 회원 (클라우드 서재)</strong>: 올린 책이 Firebase 클라우드 공간에 영구 저장되어, 언제 어디서든 로그인만 하면 서재를 동기화하여 읽을 수 있습니다. (전체 저장소 제한 5GB)</p>
            </div>
            <div className="info-divider" />
            <div className="info-block">
              <h2>Service Information</h2>
              <p>This service is a private library web app for reading study PDF files in a flipbook format.</p>
              <p>After logging in with Google, you can upload and read your own PDF documents.</p>
              <p><strong>Free Member (Local Reader)</strong>: Uploaded files are not saved on the server but temporarily loaded in the browser. Max 500MB per file, up to 5 concurrent books on the shelf.</p>
              <p><strong>Paid Member (Cloud Library)</strong>: Uploaded books are permanently stored in the Firebase cloud space, synchronized across all devices when you log in. (Total storage limit 5GB)</p>
            </div>
          </div>
          <div className="membership-status">
            <div className="status-label">
              <span>회원 등급 / Membership Status</span>
              <h3>{isCloudUser ? "유료 클라우드 회원 / Premium Cloud Member" : "무료 로컬 회원 / Free Local Member"}</h3>
            </div>
            <a href="https://docs.google.com/forms/d/e/1FAIpQLSfW0nR52Mo-O-Sp1bjfRlwakcDTSBGwY1_KaZWrhU99-VVyJA/viewform" target="_blank" rel="noopener noreferrer" className="support-link-btn">
              저장 기능 사용 문의 / Request Cloud Storage
            </a>
          </div>
        </div>

        {/* Usage Stats (Progress Bar) */}
        <div className="usage-wrap">
          <div className="usage-left">
            <span className="usage-title">
              {isCloudUser ? "서버 저장소 사용량 / Cloud Storage Usage" : "책장 등록 개수 / Local Book Slots"}
            </span>
            <div className="usage-bar-track">
              <div 
                className="usage-bar-fill" 
                style={{ 
                  width: isCloudUser 
                    ? `${Math.min(100, (globalUsage / LIMIT) * 100)}%` 
                    : `${(localBooks.length / 5) * 100}%`,
                  background: isCloudUser
                    ? (globalUsage > LIMIT * 0.9 ? '#cc7452' : '#2b5c4f')
                    : (localBooks.length >= 5 ? '#cc7452' : '#2b5c4f')
                }} 
              />
            </div>
          </div>
          <div className="usage-right">
            <span className="usage-value">
              {isCloudUser 
                ? `${(globalUsage / 1024 / 1024 / 1024).toFixed(2)} / 5.00 GB`
                : `${localBooks.length} / 5 slots`
              }
            </span>
          </div>
        </div>

        {uploading && (
          <div className="upload-progress-bar">
            <div className="upload-progress-fill" style={{ width: `${progress}%` }} />
            <span className="upload-progress-label">UPLOADING {progress}%</span>
          </div>
        )}

        <div className="book-grid">
          {displayBooks.map((b, i) => (
            <div key={b.id} className="book-card" style={{ animationDelay: `${i * 0.05}s` }} onClick={() => setSelectedBook(b)}>
              <div className="book-cover">
                <div className="book-spine" />
                <BookIcon size={36} className="book-icon" strokeWidth={1.5} />
                <div className="book-hover-overlay"><span>OPEN</span></div>
              </div>
              <div className="book-info-wrap">
                <div className="book-text">
                  <p className="book-title">{b.title.replace('.pdf', '')}</p>
                  <p className="book-size">{(b.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
                <button className="book-delete-btn" onClick={(e) => deleteBook(b, e)} title="제거 / Remove">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
          {displayBooks.length === 0 && !uploading && (
            <div className="empty-shelf" onClick={() => fileInputRef.current?.click()}>
              <Upload size={32} strokeWidth={1.5} />
              <p>ADD YOUR FIRST PDF</p>
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <style>{css}</style>
      <div className="reader-screen">
        {isOpening && <LoadingOverlay />}
        <button className="reader-close" onClick={() => setSelectedBook(null)}><X size={18} /></button>
        {pdfDoc && (
          <>
            <div className="flipbook-wrap">
              <HTMLFlipBook
                width={480} height={680}
                size="stretch"
                minWidth={260} maxWidth={560}
                minHeight={380} maxHeight={860}
                showCover={true}
                maxShadowOpacity={0.4}
                mobileScrollSupport={true}
                ref={bookRef}>
                {[...Array(pdfDoc.numPages)].map((_, i) => <Page key={i} number={i + 1} pdfDoc={pdfDoc} />)}
              </HTMLFlipBook>
            </div>
            <div className="reader-toolbar">
              <button className="tb-btn" onClick={() => bookRef.current.pageFlip().flipPrev()}>
                <ChevronLeft size={20} />
              </button>
              <div className="tb-divider" />
              <div className="tb-page-jump">
                <input
                  type="text" value={pageInput}
                  onChange={e => setPageInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleJump()}
                  placeholder="pg" className="tb-input"
                />
                <button className="tb-jump-btn" onClick={handleJump}><ArrowRight size={14} /></button>
                <span className="tb-total">/ {pdfDoc.numPages}</span>
              </div>
              <div className="tb-divider" />
              <button className="tb-btn" onClick={() => !document.fullscreenElement ? document.documentElement.requestFullscreen() : document.exitFullscreen()}>
                <Maximize2 size={18} />
              </button>
              <div className="tb-divider" />
              <button className="tb-btn" onClick={() => bookRef.current.pageFlip().flipNext()}>
                <ChevronRight size={20} />
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..900;1,400..900&family=Outfit:wght@100..900&family=DM+Mono:wght@400;500&display=swap');
  
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background-color: #faf9f6;
    color: #1b202e;
    font-family: 'Outfit', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* Login Screen */
  .login-screen {
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: #f7f4eb; position: relative; overflow: hidden; font-family: 'Playfair Display', serif;
  }
  .login-grid-bg {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(43,92,79,.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(43,92,79,.02) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  .login-glow {
    position: absolute; width: 600px; height: 600px; border-radius: 50%;
    background: radial-gradient(circle, rgba(212,122,85,.08) 0%, transparent 70%);
    top: 50%; left: 50%; transform: translate(-50%,-50%);
    animation: pulse-glow 6s ease-in-out infinite;
  }
  @keyframes pulse-glow { 0%,100%{opacity:.6;transform:translate(-50%,-50%) scale(1)} 50%{opacity:1;transform:translate(-50%,-50%) scale(1.1)} }
  .login-card {
    position: relative; z-index: 1;
    background: #ffffff; border: 1px solid #e8e5df;
    border-radius: 28px; padding: 52px 48px;
    text-align: center; width: 360px;
    box-shadow: 0 10px 40px rgba(43, 92, 79, 0.04);
  }
  .login-icon-wrap {
    width: 56px; height: 56px; background: #2b5c4f; border-radius: 16px;
    display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;
    box-shadow: 0 8px 20px rgba(43,92,79,.2);
  }
  .login-title { font-size: 42px; font-weight: 800; color: #1b202e; line-height: 1.1; letter-spacing: -1.5px; margin-bottom: 8px; }
  .login-sub { font-family: 'DM Mono', monospace; font-size: 10px; color: #6b7080; letter-spacing: 3px; margin-bottom: 36px; }
  .login-btn {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
    background: #1b202e; color: #ffffff; border: none; padding: 14px 24px;
    border-radius: 14px; font-family: 'Outfit', sans-serif; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: all .2s; letter-spacing: -.3px;
  }
  .login-btn:hover { background: #2b5c4f; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(43,92,79,.25); }

  /* Shelf Screen */
  .shelf-screen {
    min-height: 100dvh; background: #faf9f6; font-family: 'Outfit', sans-serif;
    color: #1b202e; padding: 40px 48px; position: relative;
    max-width: 1200px; margin: 0 auto;
  }
  .drop-zone {
    position: fixed; inset: 0; z-index: 999; background: rgba(43,92,79,.05);
    border: 3px dashed #2b5c4f; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 16px;
    font-size: 20px; font-weight: 700; letter-spacing: 4px; color: #2b5c4f;
    backdrop-filter: blur(4px);
  }
  .shelf-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; border-bottom: 1px solid #e8e5df; padding-bottom: 24px; }
  .shelf-title { font-family: 'Playfair Display', serif; font-size: 44px; font-weight: 800; letter-spacing: -1.5px; color: #1b202e; line-height: 1; }
  .shelf-header-right { display: flex; align-items: center; gap: 16px; }
  .user-chip {
    display: flex; align-items: center; gap: 8px;
    background: #ffffff; border: 1px solid #e8e5df;
    padding: 6px 14px 6px 6px; border-radius: 99px;
  }
  .user-avatar { width: 32px; height: 32px; border-radius: 50%; }
  .user-name { font-size: 13px; font-weight: 700; color: #1b202e; }
  .logout-btn {
    font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 700;
    color: #6b7080; background: none; border: none; cursor: pointer; transition: color .2s; letter-spacing: 1px;
  }
  .logout-btn:hover { color: #cc7452; }
  .add-btn {
    display: flex; align-items: center; gap: 8px; background: #2b5c4f; color: #ffffff; border: none;
    padding: 12px 20px; border-radius: 14px; font-family: 'Outfit', sans-serif; font-size: 13px; font-weight: 800;
    cursor: pointer; transition: all .2s; letter-spacing: .5px;
  }
  .add-btn:hover { background: #347060; transform: translateY(-2px); box-shadow: 0 8px 20px rgba(43,92,79,.2); }
  .hidden-input { display: none; }

  /* Info Card Style */
  .info-card {
    background: #ffffff; border: 1px solid #e8e5df; border-radius: 20px;
    padding: 32px; margin-bottom: 40px; box-shadow: 0 4px 20px rgba(27,32,46,.02);
  }
  .info-section {
    display: flex; gap: 32px; margin-bottom: 24px;
  }
  .info-block {
    flex: 1; text-align: left;
  }
  .info-block h2 { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 700; color: #1b202e; margin-bottom: 12px; }
  .info-block p { font-size: 13px; color: #6b7080; line-height: 1.6; margin-bottom: 8px; }
  .info-block strong { color: #1b202e; }
  .info-divider {
    width: 1px; background: #e8e5df; align-self: stretch;
  }
  .membership-status {
    display: flex; justify-content: space-between; align-items: center;
    background: #f7f4eb; border-radius: 14px; padding: 18px 24px; border: 1px solid #e8e5df;
  }
  .status-label { text-align: left; }
  .status-label span { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7080; font-weight: 700; }
  .status-label h3 { font-size: 16px; font-weight: 800; color: #2b5c4f; margin-top: 4px; }
  .support-link-btn {
    background: #cc7452; color: #ffffff; text-decoration: none; padding: 12px 20px;
    border-radius: 10px; font-size: 13px; font-weight: 700; transition: all .2s;
  }
  .support-link-btn:hover { background: #b56241; transform: translateY(-1px); }

  /* Usage stats */
  .usage-wrap {
    background: #ffffff; border: 1px solid #e8e5df; border-radius: 16px;
    padding: 16px 24px; margin-bottom: 32px; display: flex; justify-content: space-between; align-items: center;
    box-shadow: 0 4px 15px rgba(27,32,46,.01);
  }
  .usage-left { text-align: left; }
  .usage-title { font-size: 12px; font-weight: 700; color: #6b7080; text-transform: uppercase; letter-spacing: 0.5px; }
  .usage-bar-track { width: 300px; height: 6px; background: #e8e5df; border-radius: 99px; overflow: hidden; margin-top: 8px; }
  .usage-bar-fill { height: 100%; border-radius: 99px; transition: width 1s ease; }
  .usage-right { text-align: right; }
  .usage-value { font-family: 'DM Mono', monospace; font-size: 14px; font-weight: 700; color: #1b202e; }

  /* Book Grid & Cards */
  .book-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 32px; }
  .book-card { cursor: pointer; animation: fade-up .4s ease both; display: flex; flex-direction: column; }
  .book-cover {
    aspect-ratio: 3/4; background: #ffffff; border-radius: 16px;
    border: 1px solid #e8e5df; display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden; margin-bottom: 12px;
    transition: all .3s; box-shadow: 0 6px 18px rgba(27, 32, 46, 0.04);
  }
  .book-card:hover .book-cover {
    border-color: #2b5c4f; transform: translateY(-4px);
    box-shadow: 0 16px 30px rgba(27, 32, 46, 0.08);
  }
  .book-spine {
    position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
    background: linear-gradient(180deg, #2b5c4f, #347060); opacity: .8;
  }
  .book-icon { color: #6b7080; opacity: 0.3; transition: color .3s; }
  .book-card:hover .book-icon { color: #2b5c4f; opacity: 0.6; }
  .book-hover-overlay {
    position: absolute; inset: 0; background: rgba(255,255,255,.9);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .3s; font-size: 11px; font-weight: 800; letter-spacing: 3px; color: #2b5c4f;
  }
  .book-card:hover .book-hover-overlay { opacity: 1; }
  .book-info-wrap {
    text-align: left; padding: 0 4px; display: flex; justify-content: space-between; align-items: flex-start;
  }
  .book-text { flex: 1; min-width: 0; }
  .book-title {
    font-size: 13px; font-weight: 700; color: #1b202e;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -.3px;
  }
  .book-size { font-family: 'DM Mono', monospace; font-size: 10px; color: #6b7080; margin-top: 2px; }
  .book-delete-btn {
    background: none; border: none; color: #6b7080; cursor: pointer; padding: 4px;
    border-radius: 6px; transition: all .15s; margin-left: 8px; display: flex; align-items: center; justify-content: center;
  }
  .book-delete-btn:hover { background: #f7f4eb; color: #cc7452; }

  /* Empty state */
  .empty-shelf {
    grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 260px; border: 2px dashed #e8e5df; border-radius: 20px;
    color: #6b7080; font-size: 13px; font-weight: 700; letter-spacing: 3px;
    cursor: pointer; transition: all .3s; background: #ffffff;
  }
  .empty-shelf:hover { border-color: #2b5c4f; color: #2b5c4f; background: #fdfdfc; }

  /* Upload Progress */
  .upload-progress-bar {
    position: fixed; top: 0; left: 0; right: 0; height: 4px;
    background: #e8e5df; z-index: 100; overflow: visible;
  }
  .upload-progress-fill { height: 100%; background: #2b5c4f; transition: width .3s; }
  .upload-progress-label {
    position: absolute; top: 12px; right: 24px;
    font-family: 'DM Mono', monospace; font-size: 11px; color: #2b5c4f; letter-spacing: 1px; font-weight: 700;
  }

  /* Reader Screen */
  .reader-screen {
    height: 100dvh; background: #f5f3ed;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    position: relative; font-family: 'Outfit', sans-serif;
    overflow: visible;
  }
  .reader-close {
    position: fixed; top: 16px; left: 16px; z-index: 200;
    width: 38px; height: 38px; border-radius: 50%; border: 1px solid #e8e5df;
    background: #ffffff;
    display: flex; align-items: center; justify-content: center;
    color: #1b202e; cursor: pointer; transition: all .2s;
    box-shadow: 0 4px 15px rgba(27,32,46,.04);
  }
  .reader-close:hover { background: #f7f4eb; color: #cc7452; border-color: #cc7452; }

  .flipbook-wrap {
    width: 100%;
    max-width: 100vw;
    height: calc(100dvh - 76px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px 24px 0;
    overflow: visible;
  }

  /* Loading overlay */
  .loading-overlay {
    position: fixed; inset: 0; z-index: 150;
    background: #faf9f6; display: flex; align-items: center; justify-content: center;
  }
  .loading-content { display: flex; flex-direction: column; align-items: center; gap: 24px; }
  .book-anim {
    width: 60px; height: 72px; position: relative;
    border: 2px solid #e8e5df; border-radius: 3px 10px 10px 3px;
    display: flex; align-items: flex-end; justify-content: center; padding-bottom: 4px;
    overflow: hidden; background: #ffffff;
  }
  .book-page-strip {
    width: 8px; height: 100%; background: #2b5c4f; border-radius: 1px;
    animation: flip-page 1s ease-in-out infinite; transform-origin: bottom center; opacity: .7;
  }
  .loading-label { font-family: 'DM Mono', monospace; font-size: 11px; color: #6b7080; letter-spacing: 4px; font-weight: 700; }
  .loading-dots { display: flex; gap: 6px; }
  .loading-dots span {
    width: 4px; height: 4px; border-radius: 50%; background: #2b5c4f;
    animation: dot-pulse 1.2s ease-in-out infinite;
  }

  /* Reader toolbar */
  .reader-toolbar {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    z-index: 100; display: flex; align-items: center; gap: 6px;
    background: #ffffff;
    border: 1px solid #e8e5df; border-radius: 20px;
    padding: 6px 12px; height: 52px;
    box-shadow: 0 10px 30px rgba(27,32,46,.06);
  }
  .tb-btn {
    width: 38px; height: 38px; border-radius: 10px; border: none;
    background: transparent; color: #6b7080; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: all .15s;
  }
  .tb-btn:hover { background: #f7f4eb; color: #1b202e; }
  .tb-btn:active { transform: scale(.9); }
  .tb-divider { width: 1px; height: 22px; background: #e8e5df; margin: 0 4px; }
  .tb-page-jump { display: flex; align-items: center; gap: 6px; padding: 0 4px; }
  .tb-input {
    width: 48px; height: 34px; background: #faf9f6;
    border: 1px solid #e8e5df; border-radius: 8px;
    text-align: center; color: #2b5c4f; font-family: 'DM Mono', monospace;
    font-size: 13px; font-weight: 700; outline: none; transition: all .2s;
  }
  .tb-input:focus { border-color: #2b5c4f; background: #ffffff; }
  .tb-input::placeholder { color: #cbd5e1; }
  .tb-jump-btn {
    width: 30px; height: 30px; border-radius: 8px; background: #2b5c4f; border: none; color: #ffffff;
    display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .15s;
  }
  .tb-jump-btn:hover { background: #347060; }
  .tb-jump-btn:active { transform: scale(.9); }
  .tb-total { font-family: 'DM Mono', monospace; font-size: 10px; color: #6b7080; white-space: nowrap; font-weight: 700; }
  .page-spinner {
    width: 24px; height: 24px; border: 2px solid rgba(0,0,0,.05);
    border-top-color: #2b5c4f; border-radius: 50%; animation: spin .8s linear infinite;
  }
`;