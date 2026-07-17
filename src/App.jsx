import React, { useState, useEffect, useRef } from 'react';
import { db, storage, auth, googleProvider } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, getDocs, query, orderBy, where, doc, runTransaction, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { Book as BookIcon, Plus, ChevronLeft, ChevronRight, Maximize2, X, ArrowRight, Upload } from 'lucide-react';
import HTMLFlipBook from 'react-pageflip';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

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
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8f8f6' }}>
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
  const [selectedBook, setSelectedBook] = useState(null);
  const [books, setBooks] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [isOpening, setIsOpening] = useState(false);
  const [globalUsage, setGlobalUsage] = useState(0);
  const [pageInput, setPageInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const bookRef = useRef(null);
  const fileInputRef = useRef(null);
  const LIMIT = 5 * 1024 * 1024 * 1024;

  useEffect(() => {
    const unsub1 = onAuthStateChanged(auth, u => {
      setUser(u);
      if (u) fetchBooks(u.uid); else { setBooks([]); setSelectedBook(null); }
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
      .catch(() => { alert('로딩 실패'); setIsOpening(false); setSelectedBook(null); });
  }, [selectedBook]);

  const handleJump = () => {
    const p = parseInt(pageInput);
    if (p > 0 && p <= pdfDoc?.numPages) {
      bookRef.current.pageFlip().turnToPage(p - 1);
      setPageInput('');
    } else alert(`1 ~ ${pdfDoc?.numPages} 사이를 입력하세요`);
  };

  const doUpload = async file => {
    if (!file || !user) return;
    if (!file.name.endsWith('.pdf')) return alert('PDF 파일만 업로드 가능합니다.');
    if (globalUsage + file.size > LIMIT) return alert('⚠️ 용량 초과!');
    setUploading(true); setProgress(0);
    const sRef = ref(storage, `pdfs/${user.uid}/${Date.now()}_${file.name}`);
    const task = uploadBytesResumable(sRef, file);
    task.on('state_changed', s => setProgress(Math.round(s.bytesTransferred / s.totalBytes * 100)),
      () => setUploading(false),
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        await runTransaction(db, async t => {
          const sr = doc(db, 'global_stats', 'storage');
          const sd = await t.get(sr);
          t.set(sr, { totalBytes: (sd.exists() ? sd.data().totalBytes : 0) + file.size }, { merge: true });
          t.set(doc(collection(db, 'books')), { title: file.name, url, userId: user.uid, size: file.size, createdAt: new Date() });
        });
        setUploading(false); fetchBooks(user.uid);
      });
  };

  if (!user) return (
    <>
      <style>{css}</style>
      <div className="login-screen">
        <div className="login-grid-bg" />
        <div className="login-glow" />
        <div className="login-card">
          <div className="login-icon-wrap">
            <BookIcon size={28} color="#0a0a0a" strokeWidth={2.5} />
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
            <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/></svg>
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
          <div>
            <h1 className="shelf-title">PDF SHELF</h1>
            <div className="usage-bar-wrap">
              <div className="usage-bar-track">
                <div className="usage-bar-fill" style={{ width: `${(globalUsage / LIMIT) * 100}%`, background: globalUsage > LIMIT * 0.9 ? '#ef4444' : '#10b981' }} />
              </div>
              <span className="usage-text">{(globalUsage / 1024 / 1024 / 1024).toFixed(2)} / 5.00 GB</span>
            </div>
          </div>
          <div className="shelf-header-right">
            <div className="user-chip">
              <img src={user.photoURL} className="user-avatar" alt="avatar" />
              <span className="user-name">{user.displayName?.split(' ')[0]}</span>
              <button className="logout-btn" onClick={() => signOut(auth)}>OUT</button>
            </div>
            <button className="add-btn" onClick={() => fileInputRef.current?.click()}>
              <Plus size={18} strokeWidth={3} /> ADD PDF
            </button>
            <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden-input" onChange={e => doUpload(e.target.files[0])} />
          </div>
        </header>
        {uploading && (
          <div className="upload-progress-bar">
            <div className="upload-progress-fill" style={{ width: `${progress}%` }} />
            <span className="upload-progress-label">UPLOADING {progress}%</span>
          </div>
        )}
        <div className="book-grid">
          {books.map((b, i) => (
            <div key={b.id} className="book-card" style={{ animationDelay: `${i * 0.05}s` }} onClick={() => setSelectedBook(b)}>
              <div className="book-cover">
                <div className="book-spine" />
                <BookIcon size={36} className="book-icon" strokeWidth={1.5} />
                <div className="book-hover-overlay"><span>OPEN</span></div>
              </div>
              <p className="book-title">{b.title.replace('.pdf', '')}</p>
              <p className="book-size">{(b.size / 1024 / 1024).toFixed(1)} MB</p>
            </div>
          ))}
          {books.length === 0 && !uploading && (
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
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .login-screen {
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: #080808; position: relative; overflow: hidden; font-family: 'Syne', sans-serif;
  }
  .login-grid-bg {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  .login-glow {
    position: absolute; width: 600px; height: 600px; border-radius: 50%;
    background: radial-gradient(circle, rgba(16,185,129,.15) 0%, transparent 70%);
    top: 50%; left: 50%; transform: translate(-50%,-50%);
    animation: pulse-glow 4s ease-in-out infinite;
  }
  @keyframes pulse-glow { 0%,100%{opacity:.6;transform:translate(-50%,-50%) scale(1)} 50%{opacity:1;transform:translate(-50%,-50%) scale(1.1)} }
  .login-card {
    position: relative; z-index: 1;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1);
    backdrop-filter: blur(24px); border-radius: 28px; padding: 52px 48px;
    text-align: center; width: 340px;
  }
  .login-icon-wrap {
    width: 56px; height: 56px; background: #10b981; border-radius: 16px;
    display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;
    box-shadow: 0 0 40px rgba(16,185,129,.5);
  }
  .login-title { font-size: 48px; font-weight: 800; color: #fff; line-height: 1; letter-spacing: -2px; margin-bottom: 8px; }
  .login-sub { font-family: 'DM Mono', monospace; font-size: 10px; color: rgba(255,255,255,.3); letter-spacing: 3px; margin-bottom: 36px; }
  .login-btn {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px;
    background: #fff; color: #111; border: none; padding: 14px 24px;
    border-radius: 14px; font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: all .2s; letter-spacing: -.3px;
  }
  .login-btn:hover { background: #10b981; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(16,185,129,.4); }

  .shelf-screen {
    min-height: 100dvh; background: #0d0d0d; font-family: 'Syne', sans-serif;
    color: #fff; padding: 40px 48px; position: relative;
  }
  .drop-zone {
    position: fixed; inset: 0; z-index: 999; background: rgba(16,185,129,.1);
    border: 3px dashed #10b981; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 16px;
    font-size: 20px; font-weight: 700; letter-spacing: 4px; color: #10b981;
  }
  .shelf-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 48px; }
  .shelf-title { font-size: 52px; font-weight: 800; letter-spacing: -3px; color: #fff; line-height: 1; margin-bottom: 16px; }
  .usage-bar-wrap { display: flex; align-items: center; gap: 10px; }
  .usage-bar-track { width: 200px; height: 3px; background: rgba(255,255,255,.08); border-radius: 99px; overflow: hidden; }
  .usage-bar-fill { height: 100%; border-radius: 99px; transition: width 1s ease; }
  .usage-text { font-family: 'DM Mono', monospace; font-size: 11px; color: rgba(255,255,255,.3); }
  .shelf-header-right { display: flex; align-items: center; gap: 12px; }
  .user-chip {
    display: flex; align-items: center; gap: 8px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
    padding: 6px 14px 6px 6px; border-radius: 99px;
  }
  .user-avatar { width: 32px; height: 32px; border-radius: 50%; }
  .user-name { font-size: 13px; font-weight: 700; color: rgba(255,255,255,.8); }
  .logout-btn {
    font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 500;
    color: rgba(255,255,255,.3); background: none; border: none; cursor: pointer; transition: color .2s; letter-spacing: 1px;
  }
  .logout-btn:hover { color: #ef4444; }
  .add-btn {
    display: flex; align-items: center; gap: 8px; background: #10b981; color: #0a0a0a; border: none;
    padding: 12px 20px; border-radius: 14px; font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 800;
    cursor: pointer; transition: all .2s; letter-spacing: .5px;
  }
  .add-btn:hover { background: #34d399; transform: translateY(-2px); box-shadow: 0 8px 20px rgba(16,185,129,.35); }
  .hidden-input { display: none; }
  .upload-progress-bar {
    position: fixed; top: 0; left: 0; right: 0; height: 3px;
    background: rgba(255,255,255,.05); z-index: 100; overflow: visible;
  }
  .upload-progress-fill { height: 100%; background: #10b981; transition: width .3s; box-shadow: 0 0 8px #10b981; }
  .upload-progress-label {
    position: absolute; top: 8px; right: 16px;
    font-family: 'DM Mono', monospace; font-size: 10px; color: #10b981; letter-spacing: 2px;
  }
  .book-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 24px; }
  .book-card { cursor: pointer; animation: fade-up .4s ease both; }
  @keyframes fade-up { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
  .book-cover {
    aspect-ratio: 3/4; background: #1a1a1a; border-radius: 16px;
    border: 1px solid rgba(255,255,255,.06); display: flex; align-items: center; justify-content: center;
    position: relative; overflow: hidden; margin-bottom: 10px;
    transition: all .3s; box-shadow: 0 4px 20px rgba(0,0,0,.4);
  }
  .book-card:hover .book-cover {
    border-color: rgba(16,185,129,.4); transform: translateY(-4px);
    box-shadow: 0 16px 40px rgba(0,0,0,.5), 0 0 0 1px rgba(16,185,129,.2);
  }
  .book-spine {
    position: absolute; left: 0; top: 0; bottom: 0; width: 6px;
    background: linear-gradient(180deg, #10b981, #059669); opacity: .7;
  }
  .book-icon { color: rgba(255,255,255,.12); transition: color .3s; }
  .book-card:hover .book-icon { color: rgba(16,185,129,.6); }
  .book-hover-overlay {
    position: absolute; inset: 0; background: rgba(0,0,0,.7);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .3s; font-size: 11px; font-weight: 800; letter-spacing: 3px; color: #10b981;
  }
  .book-card:hover .book-hover-overlay { opacity: 1; }
  .book-title {
    font-size: 12px; font-weight: 700; color: rgba(255,255,255,.7);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -.3px;
  }
  .book-size { font-family: 'DM Mono', monospace; font-size: 10px; color: rgba(255,255,255,.25); margin-top: 2px; }
  .empty-shelf {
    grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 240px; border: 2px dashed rgba(255,255,255,.08); border-radius: 20px;
    color: rgba(255,255,255,.2); font-size: 13px; font-weight: 700; letter-spacing: 3px;
    cursor: pointer; transition: all .3s;
  }
  .empty-shelf:hover { border-color: rgba(16,185,129,.3); color: rgba(16,185,129,.5); }

  .reader-screen {
    height: 100dvh; background: #0a0a0a;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    position: relative; font-family: 'Syne', sans-serif;
    overflow: visible;
  }
  .reader-close {
    position: fixed; top: 16px; left: 16px; z-index: 200;
    width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,.1);
    background: rgba(255,255,255,.05); backdrop-filter: blur(12px);
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,.6); cursor: pointer; transition: all .2s;
  }
  .reader-close:hover { background: rgba(239,68,68,.15); border-color: rgba(239,68,68,.3); color: #ef4444; }

  /* ✅ 핵심: drop-shadow 제거, overflow visible, 적절한 패딩으로 클리핑 방지 */
  .flipbook-wrap {
    width: 100%;
    max-width: 100vw;
    height: calc(100dvh - 72px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px 24px 0;
    overflow: visible;
  }

  .loading-overlay {
    position: fixed; inset: 0; z-index: 150;
    background: #0a0a0a; display: flex; align-items: center; justify-content: center;
  }
  .loading-content { display: flex; flex-direction: column; align-items: center; gap: 24px; }
  .book-anim {
    width: 60px; height: 72px; position: relative;
    border: 2px solid rgba(255,255,255,.1); border-radius: 3px 10px 10px 3px;
    display: flex; align-items: flex-end; justify-content: center; padding-bottom: 4px;
    overflow: hidden; background: rgba(16,185,129,.05);
  }
  .book-page-strip {
    width: 8px; height: 100%; background: #10b981; border-radius: 1px;
    animation: flip-page 1s ease-in-out infinite; transform-origin: bottom center; opacity: .7;
  }
  @keyframes flip-page { 0%,100%{transform:scaleY(0.1);opacity:.3} 50%{transform:scaleY(1);opacity:1} }
  .loading-label { font-family: 'DM Mono', monospace; font-size: 11px; color: rgba(255,255,255,.3); letter-spacing: 4px; }
  .loading-dots { display: flex; gap: 6px; }
  .loading-dots span {
    width: 4px; height: 4px; border-radius: 50%; background: #10b981;
    animation: dot-pulse 1.2s ease-in-out infinite;
  }
  @keyframes dot-pulse { 0%,100%{opacity:.2;transform:scale(.8)} 50%{opacity:1;transform:scale(1)} }

  .reader-toolbar {
    position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
    z-index: 100; display: flex; align-items: center; gap: 4px;
    background: rgba(18,18,18,.96); backdrop-filter: blur(24px);
    border: 1px solid rgba(255,255,255,.08); border-radius: 18px;
    padding: 6px 10px; height: 52px;
    box-shadow: 0 8px 40px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.03);
  }
  .tb-btn {
    width: 38px; height: 38px; border-radius: 10px; border: none;
    background: transparent; color: rgba(255,255,255,.5); cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: all .15s;
  }
  .tb-btn:hover { background: rgba(255,255,255,.07); color: #fff; }
  .tb-btn:active { transform: scale(.9); }
  .tb-divider { width: 1px; height: 22px; background: rgba(255,255,255,.08); margin: 0 3px; }
  .tb-page-jump { display: flex; align-items: center; gap: 5px; padding: 0 3px; }
  .tb-input {
    width: 48px; height: 34px; background: rgba(255,255,255,.07);
    border: 1px solid rgba(255,255,255,.1); border-radius: 9px;
    text-align: center; color: #10b981; font-family: 'DM Mono', monospace;
    font-size: 13px; font-weight: 500; outline: none; transition: all .2s;
  }
  .tb-input:focus { border-color: rgba(16,185,129,.5); background: rgba(16,185,129,.08); }
  .tb-input::placeholder { color: rgba(255,255,255,.2); }
  .tb-jump-btn {
    width: 30px; height: 30px; border-radius: 8px; background: #10b981; border: none; color: #0a0a0a;
    display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .15s;
  }
  .tb-jump-btn:hover { background: #34d399; }
  .tb-jump-btn:active { transform: scale(.9); }
  .tb-total { font-family: 'DM Mono', monospace; font-size: 10px; color: rgba(255,255,255,.25); white-space: nowrap; }
  .page-spinner {
    width: 24px; height: 24px; border: 2px solid rgba(0,0,0,.1);
    border-top-color: #10b981; border-radius: 50%; animation: spin .8s linear infinite;
  }
  @keyframes spin { to{transform:rotate(360deg)} }
`;