import React, { useState, useEffect, useRef } from 'react';
import { db, storage, auth, googleProvider } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import { collection, getDocs, query, orderBy, where, doc, runTransaction, onSnapshot, deleteDoc } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { Book as BookIcon, Plus, ChevronLeft, ChevronRight, Maximize2, X, ArrowRight, Upload, Trash2, Zap, Cloud, ZoomIn } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const AUTHORIZED_EMAILS = [
  'skateboard4335@gmail.com',
  'jeki4332@gmail.com'
];

const fileCache = new Map();
const localFileMap = new Map();
const CACHE_NAME = 'pdf-shelf-persistent-v1';

// 고화질 단일 PDF 페이지 렌더링 캔버스 컴포넌트 (100% 정밀 핏 & 하단 여백 완벽 제거)
function PdfCanvasPage({ pdfDoc, pageNum, width, height, shadowType }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (!pdfDoc || !pageNum || pageNum < 1 || pageNum > pdfDoc.numPages) return;

    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const unscaledVp = page.getViewport({ scale: 1.0 });
        
        // 너비와 높이에 100% 정확하게 맞추는 렌더링 스케일 계산 (2배 고해상도)
        const scaleX = width / unscaledVp.width;
        const scaleY = height / unscaledVp.height;
        const targetScale = Math.min(scaleX, scaleY) * 2.0;
        const vp = page.getViewport({ scale: targetScale });

        const canvas = canvasRef.current;
        if (!canvas || !alive) return;
        canvas.height = vp.height;
        canvas.width = vp.width;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      } catch (e) {
        console.error("Canvas render error:", e);
      }
    })();

    return () => { alive = false; };
  }, [pdfDoc, pageNum, width, height]);

  if (!pageNum || pageNum < 1 || pageNum > pdfDoc?.numPages) {
    return <div style={{ width, height, background: 'transparent' }} />;
  }

  let boxShadow = '0 8px 30px rgba(0,0,0,0.12)';
  if (shadowType === 'left') {
    boxShadow = '-4px 4px 16px rgba(0,0,0,0.06), inset -12px 0 16px -10px rgba(0,0,0,0.15)';
  } else if (shadowType === 'right') {
    boxShadow = '4px 4px 16px rgba(0,0,0,0.06), inset 12px 0 16px -10px rgba(0,0,0,0.15)';
  }

  return (
    <div style={{
      width,
      height: 'auto',
      maxHeight: height,
      background: '#ffffff',
      position: 'relative',
      overflow: 'hidden',
      boxShadow,
      transition: 'all 0.15s ease',
      borderRadius: shadowType === 'left' ? '4px 0 0 4px' : (shadowType === 'right' ? '0 4px 4px 0' : '4px'),
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <canvas ref={canvasRef} className="pdf-page-canvas" style={{ width: '100%', height: 'auto', maxHeight: '100%', display: 'block' }} />
    </div>
  );
}

// 100% 정중앙, 화면 최대 정밀 규격 자동 계산 커스텀 PDF 뷰어
function CustomPdfReader({ pdfDoc, onClose, isTwoPage, setIsTwoPage }) {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [showToolbar, setShowToolbar] = useState(true);
  const [pageAspect, setPageAspect] = useState(0.707); // 기본 A4 비율
  const [dimensions, setDimensions] = useState({ singleW: 400, singleH: 600 });
  const [isMagnifierActive, setIsMagnifierActive] = useState(false);
  const [isOverPage, setIsOverPage] = useState(false);
  const [mousePos, setMousePos] = useState({ x: -1000, y: -1000 });
  const [magnifierScale, setMagnifierScale] = useState(1.0); // 돋보기 렌즈 크기 비율 (0.6 ~ 1.8배)
  
  const timerRef = useRef(null);
  const lensCanvasRef = useRef(null);
  const numPages = pdfDoc.numPages;

  // 동적 돋보기 크기 계산
  const lensW = Math.round(360 * magnifierScale);
  const lensH = Math.round(200 * magnifierScale);

  // 마우스 휠 조작으로 돋보기 렌즈 크기 실시간 조절
  useEffect(() => {
    if (!isMagnifierActive) return;
    const handleWheel = (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        setMagnifierScale(prev => Math.min(prev + 0.1, 1.8));
      } else if (e.deltaY > 0) {
        setMagnifierScale(prev => Math.max(prev - 0.1, 0.6));
      }
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [isMagnifierActive]);

  // 첫 페이지 종횡비 가져오기 (즉시 계산)
  useEffect(() => {
    if (pdfDoc) {
      pdfDoc.getPage(1).then(page => {
        const vp = page.getViewport({ scale: 1.0 });
        if (vp.width && vp.height) {
          setPageAspect(vp.width / vp.height);
        }
      });
    }
  }, [pdfDoc]);

  const isPortrait = window.innerWidth < window.innerHeight;
  const showTwoPage = isTwoPage && !isPortrait && currentPage > 1;

  // 화면 크기 및 1P/2P 모드에 따라 딱 들어맞는 단일 페이지 규격 정밀 계산
  useEffect(() => {
    const calcDimensions = () => {
      const isFull = !!document.fullscreenElement;
      const topSpace = isFull ? 12 : 54;
      const bottomSpace = isFull ? 12 : 64;
      
      const maxH = Math.max(200, window.innerHeight - topSpace - bottomSpace);
      const maxW = Math.max(200, window.innerWidth - (isFull ? 16 : 32));

      let singleW, singleH;

      if (showTwoPage) {
        const doubleAspect = pageAspect * 2;
        let h_A = maxH;
        let w_A_total = h_A * doubleAspect;

        if (w_A_total <= maxW) {
          singleH = h_A;
          singleW = h_A * pageAspect;
        } else {
          let w_B_total = maxW;
          singleW = w_B_total / 2;
          singleH = singleW / pageAspect;
        }
      } else {
        let h_A = maxH;
        let w_A = h_A * pageAspect;

        if (w_A <= maxW) {
          singleH = h_A;
          singleW = w_A;
        } else {
          singleW = maxW;
          singleH = maxW / pageAspect;
        }
      }

      setDimensions({
        singleW: Math.floor(singleW),
        singleH: Math.floor(singleH)
      });
    };

    calcDimensions();
    window.addEventListener('resize', calcDimensions);
    window.addEventListener('fullscreenchange', calcDimensions);
    return () => {
      window.removeEventListener('resize', calcDimensions);
      window.removeEventListener('fullscreenchange', calcDimensions);
    };
  }, [pageAspect, showTwoPage, pdfDoc, isTwoPage, currentPage]);

  // 마우스 이동 감지 (툴바 자동 숨김 & PDF 영역 위에서만 돋보기 활성화)
  const handleMouseMove = (e) => {
    setShowToolbar(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setShowToolbar(false);
    }, 2500);

    const mx = e.clientX;
    const my = e.clientY;
    setMousePos({ x: mx, y: my });

    if (isMagnifierActive) {
      const pageCanvases = document.querySelectorAll('.pdf-page-canvas');
      let found = false;
      pageCanvases.forEach(c => {
        const r = c.getBoundingClientRect();
        if (mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
          found = true;
        }
      });
      setIsOverPage(found);
    }
  };

  // 돋보기 실시간 2.6배 고화질 크롭 렌더링
  useEffect(() => {
    if (!isMagnifierActive || !isOverPage) return;
    const lensCanvas = lensCanvasRef.current;
    if (!lensCanvas) return;
    const ctx = lensCanvas.getContext('2d');
    ctx.clearRect(0, 0, lensW, lensH);

    const pageCanvases = document.querySelectorAll('.pdf-page-canvas');
    pageCanvases.forEach(sourceCanvas => {
      const rect = sourceCanvas.getBoundingClientRect();
      if (
        mousePos.x >= rect.left && mousePos.x <= rect.right &&
        mousePos.y >= rect.top && mousePos.y <= rect.bottom
      ) {
        const scaleX = sourceCanvas.width / rect.width;
        const scaleY = sourceCanvas.height / rect.height;
        const clickX = (mousePos.x - rect.left) * scaleX;
        const clickY = (mousePos.y - rect.top) * scaleY;

        const zoom = 2.6;
        const sw = (lensW / zoom) * scaleX;
        const sh = (lensH / zoom) * scaleY;
        const sx = clickX - sw / 2;
        const sy = clickY - sh / 2;

        try {
          ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, lensW, lensH);
        } catch (e) {
          console.error("Magnifier draw failure:", e);
        }
      }
    });
  }, [mousePos, isMagnifierActive, isOverPage, lensW, lensH]);

  const turnNext = () => {
    if (!showTwoPage) {
      if (currentPage < numPages) setCurrentPage(prev => prev + 1);
    } else {
      if (currentPage + 2 <= numPages) setCurrentPage(prev => prev + 2);
      else if (currentPage + 1 <= numPages) setCurrentPage(prev => prev + 1);
    }
  };

  const turnPrev = () => {
    if (!showTwoPage) {
      if (currentPage > 1) setCurrentPage(prev => prev - 1);
    } else {
      if (currentPage <= 3) setCurrentPage(1);
      else setCurrentPage(prev => prev - 2);
    }
  };

  const jumpTo = (p) => {
    const target = parseInt(p);
    if (target >= 1 && target <= numPages) {
      if (showTwoPage && target > 1 && target % 2 === 1) {
        setCurrentPage(target - 1);
      } else {
        setCurrentPage(target);
      }
      setPageInput('');
    } else {
      alert(`1 ~ ${numPages} 사이의 페이지를 입력하세요.`);
    }
  };

  // 키보드 조작: W(다음), S(이전)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'd' || k === 'arrowright' || k === 'space' || k === 'pagedown') { 
        turnNext(); 
      }
      if (k === 's' || k === 'a' || k === 'arrowleft' || k === 'pageup') { 
        turnPrev(); 
      }
      if (e.key === 'Escape') { onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, showTwoPage, numPages]);

  return (
    <div className="reader-screen" onMouseMove={handleMouseMove}>
      <button className="reader-close" onClick={onClose}><X size={18} /></button>

      {/* PDF 페이지 영역 안에서만 나타나는 동적 조절 대형 돋보기 렌즈 */}
      {isMagnifierActive && isOverPage && (
        <div
          style={{
            position: 'fixed',
            left: mousePos.x - lensW / 2,
            top: mousePos.y - lensH / 2,
            width: lensW,
            height: lensH,
            borderRadius: 16,
            border: '2.5px solid #2b5c4f',
            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.35)',
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: 100,
            background: '#ffffff'
          }}
        >
          <canvas ref={lensCanvasRef} width={lensW} height={lensH} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
      )}

      {/* 화면 좌우 영역 클릭 시 즉시 페이지 이동 */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', zIndex: 25 }}>
        <div
          style={{ flex: 1, cursor: isMagnifierActive && isOverPage ? 'none' : 'pointer' }}
          onClick={turnPrev}
          title={isMagnifierActive ? '' : '이전 페이지 (S / A / ←)'}
        />
        <div
          style={{ flex: 1, cursor: isMagnifierActive && isOverPage ? 'none' : 'pointer' }}
          onClick={turnNext}
          title={isMagnifierActive ? '' : '다음 페이지 (W / D / →)'}
        />
      </div>

      {/* PDF 뷰어 메인 공간 (100% 정중앙 플렉스 레이아웃) */}
      <div style={{ zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!showTwoPage ? (
          // 단일 페이지 모드 (표지 또는 1P 모드)
          <PdfCanvasPage
            pdfDoc={pdfDoc}
            pageNum={currentPage}
            width={dimensions.singleW}
            height={dimensions.singleH}
            shadowType="single"
          />
        ) : (
          // 양면 모드 (2페이지 나란히 뷰 - 책등 입체감 연출)
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <PdfCanvasPage
              pdfDoc={pdfDoc}
              pageNum={currentPage}
              width={dimensions.singleW}
              height={dimensions.singleH}
              shadowType="left"
            />
            <PdfCanvasPage
              pdfDoc={pdfDoc}
              pageNum={currentPage + 1 <= numPages ? currentPage + 1 : null}
              width={dimensions.singleW}
              height={dimensions.singleH}
              shadowType="right"
            />
          </div>
        )}
      </div>

      {/* 하단 툴바 (2.5초 조작 없을 시 자동 페이드아웃) */}
      <div 
        className="reader-toolbar" 
        style={{ 
          zIndex: 30,
          opacity: showToolbar ? 1 : 0,
          pointerEvents: showToolbar ? 'auto' : 'none',
          transform: showToolbar ? 'translate(-50%, 0)' : 'translate(-50%, 20px)',
          transition: 'all 0.3s ease'
        }}
      >
        <button className="tb-btn" onClick={turnPrev} title="이전 (S / A / ←)"><ChevronLeft size={20} /></button>
        <div className="tb-divider" />
        <div className="tb-page-jump">
          <input
            type="text" value={pageInput}
            onChange={e => setPageInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && jumpTo(pageInput)}
            placeholder={!showTwoPage ? `${currentPage}` : `${currentPage}-${Math.min(currentPage + 1, numPages)}`}
            className="tb-input"
          />
          <button className="tb-jump-btn" onClick={() => jumpTo(pageInput)}><ArrowRight size={14} /></button>
          <span className="tb-total">/ {numPages}</span>
        </div>
        <div className="tb-divider" />
        {/* 1P / 2P 보기 모드 전환 버튼 */}
        <button 
          className="tb-btn" 
          onClick={() => setIsTwoPage(!isTwoPage)} 
          title={isTwoPage ? "한 쪽 보기로 전환 (1P)" : "두 쪽 보기로 전환 (2P)"}
          style={{ fontSize: '11px', fontStyle: 'normal', fontWeight: 800, color: isTwoPage ? '#2b5c4f' : '#6b7080' }}
        >
          {isTwoPage ? '2P' : '1P'}
        </button>
        <div className="tb-divider" />
        {/* 대형 동적 돋보기 온/오프 버튼 */}
        <button
          className="tb-btn"
          onClick={() => setIsMagnifierActive(!isMagnifierActive)}
          title={isMagnifierActive ? "돋보기 끄기" : "휠 스크롤 조절 돋보기 키기"}
          style={{
            background: isMagnifierActive ? '#2b5c4f' : 'transparent',
            color: isMagnifierActive ? '#ffffff' : '#6b7080'
          }}
        >
          <ZoomIn size={18} />
        </button>
        <div className="tb-divider" />
        <button className="tb-btn" onClick={() => !document.fullscreenElement ? document.documentElement.requestFullscreen() : document.exitFullscreen()} title="전체화면">
          <Maximize2 size={18} />
        </button>
        <div className="tb-divider" />
        <button className="tb-btn" onClick={turnNext} title="다음 (W / D / →)"><ChevronRight size={20} /></button>
      </div>
    </div>
  );
}

function LoadingOverlay({ progress }) {
  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="book-anim">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="book-page-strip" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <p className="loading-label">OPENING ARCHIVE</p>
        <span className="loading-progress-val">{progress || '0%'}</span>
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
  const [books, setBooks] = useState([]);
  const [localBooks, setLocalBooks] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [isOpening, setIsOpening] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('0%');
  const [globalUsage, setGlobalUsage] = useState(0);
  const [userUsageList, setUserUsageList] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [isTwoPage, setIsTwoPage] = useState(true); // 기본값: 2페이지 양면(2P) 뷰어 모드

  const dragCounter = useRef(0);
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

  // 유저별 클라우드 용량 분이 점유 현황 멀티 컬러 트래킹
  useEffect(() => {
    if (!user || !isCloudUser) return;
    const q = query(collection(db, 'books'));
    const unsub = onSnapshot(q, snap => {
      const map = {};
      snap.docs.forEach(doc => {
        const b = doc.data();
        const uid = b.userId || 'unknown';
        map[uid] = (map[uid] || 0) + (b.size || 0);
      });

      const colors = ['#2b5c4f', '#cc7452', '#7c3aed', '#d97706', '#2563eb', '#db2777'];
      const list = Object.entries(map).map(([uid, bytes], index) => {
        let name = '기타 유저';
        if (uid === user.uid) {
          name = `${user.displayName?.split(' ')[0]} (나)`;
        } else if (uid.includes('skateboard') || uid === 'skateboard4335@gmail.com') {
          name = 'skateboard4335@gmail.com';
        } else if (uid.includes('jeki') || uid === 'jeki4332@gmail.com') {
          name = 'jeki4332@gmail.com';
        } else {
          name = `User (${uid.slice(0, 6)}...)`;
        }

        return {
          uid,
          bytes,
          name,
          color: uid === user.uid ? '#2b5c4f' : colors[(index + 1) % colors.length]
        };
      });

      setUserUsageList(list);
    });
    return () => unsub();
  }, [user, isCloudUser]);

  const fetchBooks = async uid => {
    try {
      const q = query(collection(db, 'books'), where('userId', '==', uid));
      const snap = await getDocs(q);
      const fetchedBooks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      fetchedBooks.sort((a, b) => {
        const timeA = a.createdAt?.seconds || 0;
        const timeB = b.createdAt?.seconds || 0;
        return timeB - timeA;
      });
      
      setBooks(fetchedBooks);

      // 백그라운드 영구 캐싱 (Idle 사전 다운로드로 다음 클릭 시 0초 로딩)
      if ('caches' in window) {
        window.caches.open(CACHE_NAME).then(cache => {
          fetchedBooks.forEach(b => {
            if (b.url) {
              cache.match(b.url).then(match => {
                if (!match) {
                  fetch(b.url).then(res => {
                    if (res.ok) cache.put(b.url, res.clone());
                  }).catch(() => {});
                }
              });
            }
          });
        });
      }
    } catch (err) {
      console.error("fetchBooks error:", err);
      alert("도서 목록 로드 실패: " + err.message);
    }
  };

  // 초고속 PDF 오픈 (영구 브라우저 디스크 캐시 Cache API & 100% 대역폭 0초 로딩)
  useEffect(() => {
    if (!selectedBook) { setPdfDoc(null); return; }
    setIsOpening(true);
    setDownloadProgress('0%');

    const cacheKey = `${selectedBook.id || selectedBook.title}_${selectedBook.size}`;
    
    // 1. 메모리 캐시(fileCache)에 이미 들어있는 경우 즉시 오픈
    if (fileCache.has(cacheKey)) {
      const cachedBuf = fileCache.get(cacheKey);
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(cachedBuf),
        cMapUrl: 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/',
        cMapPacked: true,
      });
      loadingTask.promise.then(pdf => {
        setPdfDoc(pdf);
        setTimeout(() => setIsOpening(false), 30);
      });
      return;
    }

    // 2. 로컬 파일 객체가 있는 경우
    const fileObj = selectedBook.file || localFileMap.get(`${selectedBook.title}_${selectedBook.size}`);
    if (fileObj) {
      fileObj.arrayBuffer().then(buf => {
        fileCache.set(cacheKey, buf);
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/',
          cMapPacked: true,
        });
        loadingTask.promise.then(pdf => {
          setPdfDoc(pdf);
          setTimeout(() => setIsOpening(false), 30);
        });
      });
      return;
    }

    // 3. 영구 Cache API (디스크 캐시)에서 사전 로딩된 데이터 확인 (0.00초 즉시 오픈)
    if ('caches' in window && selectedBook.url) {
      caches.open(CACHE_NAME).then(cache => {
        cache.match(selectedBook.url).then(async match => {
          if (match) {
            const buf = await match.arrayBuffer();
            fileCache.set(cacheKey, buf);
            const loadingTask = pdfjsLib.getDocument({
              data: new Uint8Array(buf),
              cMapUrl: 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/',
              cMapPacked: true,
            });
            const pdf = await loadingTask.promise;
            setPdfDoc(pdf);
            setTimeout(() => setIsOpening(false), 30);
          } else {
            // 디스크 캐시에 없으면 초고속 스트림 Fetch로 전속력 다운로드 후 캐싱
            fetchCloudPdf(selectedBook, cacheKey, cache);
          }
        }).catch(() => fetchCloudPdf(selectedBook, cacheKey, null));
      }).catch(() => fetchCloudPdf(selectedBook, cacheKey, null));
      return;
    }

    fetchCloudPdf(selectedBook, cacheKey, null);
  }, [selectedBook]);

  // 클라우드 PDF 전속력 스트림 다운로드 함수
  const fetchCloudPdf = (book, cacheKey, persistentCache) => {
    fetch(book.url)
      .then(async response => {
        if (persistentCache) {
          persistentCache.put(book.url, response.clone());
        }
        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : book.size || 0;
        const reader = response.body.getReader();
        let receivedLength = 0;
        let chunks = [];

        while(true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedLength += value.length;
          if (total > 0) {
            const percent = Math.round((receivedLength / total) * 100);
            setDownloadProgress(`${percent}%`);
          } else {
            setDownloadProgress(`${(receivedLength / 1024 / 1024).toFixed(1)} MB`);
          }
        }

        const chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for(let chunk of chunks) {
          chunksAll.set(chunk, position);
          position += chunk.length;
        }

        const buf = chunksAll.buffer;
        fileCache.set(cacheKey, buf);

        const loadingTask = pdfjsLib.getDocument({
          data: chunksAll,
          cMapUrl: 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/',
          cMapPacked: true,
        });
        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setTimeout(() => setIsOpening(false), 30);
      })
      .catch(err => {
        console.error("Cloud PDF fetch error:", err);
        alert("PDF 로드 실패: " + err.message);
        setIsOpening(false);
        setSelectedBook(null);
      });
  };

  const handleDragEnter = (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) setDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false); dragCounter.current = 0;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelected(e.dataTransfer.files[0]);
    }
  };

  const onFileSelected = (file) => {
    if (!file) return;
    if (!file.name.endsWith('.pdf')) {
      alert('PDF 파일만 등록 가능합니다.');
      return;
    }
    const MAX_SIZE = 500 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      alert('파일 크기가 500MB를 초과합니다.');
      return;
    }
    localFileMap.set(`${file.name}_${file.size}`, file);
    setPendingFile(file);
  };

  const handleQuickOpen = (file) => {
    const targetFile = file || pendingFile;
    if (!targetFile) return;

    if (!isCloudUser && localBooks.length >= 5) {
      alert('무료 회원은 최대 5권까지만 추가할 수 있습니다.');
      setPendingFile(null);
      return;
    }

    const localUrl = URL.createObjectURL(targetFile);
    const newBook = {
      id: Date.now().toString(),
      title: targetFile.name,
      size: targetFile.size,
      url: localUrl,
      isLocal: true,
      file: targetFile
    };

    if (!isCloudUser) {
      setLocalBooks(prev => [newBook, ...prev]);
    }

    setPendingFile(null);
    setSelectedBook(newBook);
  };

  const handleCloudSave = async (file) => {
    const targetFile = file || pendingFile;
    if (!targetFile || !user) return;
    setPendingFile(null);

    const cacheKey = `${targetFile.name}_${targetFile.size}`;
    fileCache.set(cacheKey, URL.createObjectURL(targetFile));

    setUploading(true); setProgress(0);
    const sRef = ref(storage, `pdfs/${user.uid}/${Date.now()}_${targetFile.name}`);
    const task = uploadBytesResumable(sRef, targetFile);
    
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
            t.set(sr, { totalBytes: (sd.exists() ? sd.data().totalBytes : 0) + targetFile.size }, { merge: true });
            t.set(doc(collection(db, 'books')), { 
              title: targetFile.name, 
              url, 
              userId: user.uid, 
              size: targetFile.size, 
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
    e.stopPropagation();
    
    const confirmMsg = isCloudUser && !book.isLocal
      ? '이 책을 서버에서 완전히 삭제하시겠습니까?' 
      : '선반에서 이 책을 빼시겠습니까?';
      
    if (!confirm(confirmMsg)) return;

    if (!isCloudUser || book.isLocal) {
      URL.revokeObjectURL(book.url);
      setLocalBooks(prev => prev.filter(b => b.id !== book.id));
      if (selectedBook?.id === book.id) setSelectedBook(null);
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
      if (selectedBook?.id === book.id) setSelectedBook(null);
    } catch (e) {
      console.error(e);
      alert('삭제 실패: ' + e.message);
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
        onDragEnter={handleDragEnter}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}>
        
        {dragOver && (
          <div className="drop-zone" onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDrop={handleDrop}>
            <Upload size={56} strokeWidth={1.5} />
            <p>DROP PDF ANYWHERE</p>
            <span>페이지 어디든 파일만 올려두면 바로 등록됩니다</span>
          </div>
        )}
        
        <header className="shelf-header">
          <h1 className="shelf-title">PDF SHELF 7</h1>
          <div className="shelf-header-right">
            <div className="user-chip">
              <img src={user.photoURL} className="user-avatar" alt="avatar" />
              <span className="user-name">{user.displayName?.split(' ')[0]}</span>
              <button className="logout-btn" onClick={() => signOut(auth)}>LOGOUT</button>
            </div>
            <button className="add-btn" onClick={() => fileInputRef.current?.click()}>
              <Plus size={18} strokeWidth={3} /> ADD PDF
            </button>
            <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden-input" onChange={e => onFileSelected(e.target.files[0])} />
          </div>
        </header>

        {pendingFile && (
          <div className="modal-overlay">
            <div className="choice-card">
              <div className="choice-header">
                <BookIcon size={32} color="#2b5c4f" />
                <h3 className="choice-file-name">{pendingFile.name}</h3>
                <p className="choice-file-size">{(pendingFile.size / 1024 / 1024).toFixed(1)} MB</p>
              </div>

              <p className="choice-question">이 PDF 파일을 어떻게 처리하시겠습니까?</p>

              <div className="choice-buttons">
                <button className="choice-btn quick-btn" onClick={() => handleQuickOpen(pendingFile)}>
                  <div className="choice-btn-icon"><Zap size={22} color="#cc7452" /></div>
                  <div className="choice-btn-text">
                    <strong>⚡ 즉시 읽기 (0.1초 로컬 모드)</strong>
                    <span>서버 업로드 없이 0.1초 만에 브라우저에서 바로 엽니다.</span>
                  </div>
                </button>

                {isCloudUser ? (
                  <button className="choice-btn cloud-btn" onClick={() => handleCloudSave(pendingFile)}>
                    <div className="choice-btn-icon"><Cloud size={22} color="#2b5c4f" /></div>
                    <div className="choice-btn-text">
                      <strong>☁️ 클라우드 저장 (서버 영구 보관)</strong>
                      <span>Firebase 서버에 올려 다른 기기에서도 서재를 동기화합니다.</span>
                    </div>
                  </button>
                ) : (
                  <div className="cloud-disabled-note">
                    <span>💡 클라우드 저장 기능은 승인된 회원 전용입니다.</span>
                  </div>
                )}
              </div>

              <button className="choice-cancel-btn" onClick={() => setPendingFile(null)}>취소 / Cancel</button>
            </div>
          </div>
        )}

        <div className="info-card">
          <div className="info-section">
            <div className="info-block">
              <h2>서비스 이용 안내</h2>
              <p>본 서비스는 학습용 PDF 파일을 디지털 서재 형태로 감상하는 프로그램입니다.</p>
              <p>구글 로그인 후 본인 소유의 PDF 문서를 업로드하여 자유롭게 읽으실 수 있습니다.</p>
              <p><strong>무료 회원 (로컬 리더)</strong>: 올린 파일은 브라우저 메모리에 즉시 로딩되어 0.05초 만에 열립니다.</p>
              <p><strong>유료 회원 (클라우드 서재)</strong>: 올린 책이 Firebase 클라우드 공간에 영구 저장되어 연동됩니다.</p>
            </div>
            <div className="info-divider" />
            <div className="info-block">
              <h2>Service Information</h2>
              <p>This service is a private library web app for reading study PDF files.</p>
              <p>After logging in with Google, you can upload and read your own PDF documents.</p>
              <p><strong>Free Member (Local Reader)</strong>: Uploaded files are temporarily loaded in browser memory instantly.</p>
              <p><strong>Paid Member (Cloud Library)</strong>: Uploaded books are permanently stored in Firebase cloud space.</p>
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

        {/* 유저별 분이 용량 세그먼트 게이지 바 */}
        <div className="usage-wrap">
          <div className="usage-left">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span className="usage-title">프로젝트 공유 저장소 사용량 (유저별 세그먼트)</span>
            </div>
            <div className="usage-bar-track" style={{ display: 'flex', position: 'relative', overflow: 'hidden', width: '340px' }}>
              {userUsageList.map((item, idx) => {
                const pct = (item.bytes / LIMIT) * 100;
                const sizeMB = (item.bytes / 1024 / 1024).toFixed(1);
                const sizeGB = (item.bytes / 1024 / 1024 / 1024).toFixed(2);
                const displaySize = item.bytes > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;
                return (
                  <div
                    key={item.uid || idx}
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: item.color,
                      transition: 'all 0.3s ease',
                      cursor: 'pointer'
                    }}
                    title={`${item.name}: ${displaySize} (${pct.toFixed(1)}%)`}
                  />
                );
              })}
            </div>
            {/* 유저별 툴팁 범례 (Mouse Hover) */}
            <div style={{ display: 'flex', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
              {userUsageList.map((item, idx) => {
                const sizeMB = (item.bytes / 1024 / 1024).toFixed(1);
                const sizeGB = (item.bytes / 1024 / 1024 / 1024).toFixed(2);
                const displaySize = item.bytes > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;
                return (
                  <div key={item.uid || idx} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#6b7080' }} title={`${item.name}: ${displaySize}`}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: item.color, display: 'inline-block' }} />
                    <span style={{ fontWeight: 700, color: '#1b202e' }}>{item.name}</span>
                    <span>({displaySize})</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="usage-right">
            <span className="usage-value">{(globalUsage / 1024 / 1024 / 1024).toFixed(2)} / 5.00 GB</span>
          </div>
        </div>

        {uploading && (
          <div className="upload-overlay">
            <div className="upload-card">
              <h3>PDF 업로드 중 / Uploading PDF</h3>
              <div className="upload-progress-track">
                <div className="upload-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="upload-percentage">{progress}%</span>
              <p>서버에 파일을 안전하게 전송하는 중입니다</p>
            </div>
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
        {isOpening && <LoadingOverlay progress={downloadProgress} />}
        {pdfDoc && (
          <CustomPdfReader
            pdfDoc={pdfDoc}
            onClose={() => setSelectedBook(null)}
            isTwoPage={isTwoPage}
            setIsTwoPage={setIsTwoPage}
          />
        )}
      </div>
    </>
  );
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair Display:ital,wght@0,400..900;1,400..900&family=Outfit:wght@100..900&family=DM+Mono:wght@400;500&display=swap');
  
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
    position: fixed; inset: 0; z-index: 999; background: rgba(250,249,246,.92);
    border: 3px dashed #2b5c4f; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 16px;
    font-size: 24px; font-weight: 800; letter-spacing: 2px; color: #2b5c4f;
    backdrop-filter: blur(8px);
  }
  .drop-zone span { font-size: 13px; font-weight: 600; color: #6b7080; letter-spacing: 0; }
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

  /* Modal Overlay & Choice Card */
  .modal-overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(27, 32, 46, 0.4);
    backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center;
  }
  .choice-card {
    background: #ffffff; border: 1px solid #e8e5df; border-radius: 28px;
    padding: 36px; width: 440px; max-width: 90vw; text-align: center;
    box-shadow: 0 20px 50px rgba(27,32,46,.12); animation: fade-up .3s ease both;
  }
  .choice-header { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-bottom: 20px; }
  .choice-file-name { font-size: 16px; font-weight: 700; color: #1b202e; word-break: break-all; }
  .choice-file-size { font-family: 'DM Mono', monospace; font-size: 12px; color: #6b7080; }
  .choice-question { font-size: 14px; font-weight: 700; color: #2b5c4f; margin-bottom: 24px; }
  .choice-buttons { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
  .choice-btn {
    display: flex; align-items: center; gap: 16px; padding: 16px 20px;
    border-radius: 16px; border: 1px solid #e8e5df; background: #faf9f6;
    cursor: pointer; text-align: left; transition: all .2s;
  }
  .choice-btn:hover { transform: translateY(-2px); border-color: #2b5c4f; background: #ffffff; box-shadow: 0 8px 20px rgba(43,92,79,.08); }
  .choice-btn-icon { width: 44px; height: 44px; border-radius: 12px; background: #ffffff; border: 1px solid #e8e5df; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .choice-btn-text strong { display: block; font-size: 14px; color: #1b202e; margin-bottom: 2px; }
  .choice-btn-text span { font-size: 11px; color: #6b7080; line-height: 1.4; }
  .cloud-disabled-note { font-size: 12px; color: #6b7080; background: #f7f4eb; padding: 12px; border-radius: 12px; border: 1px solid #e8e5df; }
  .choice-cancel-btn { background: none; border: none; font-size: 13px; font-weight: 700; color: #6b7080; cursor: pointer; padding: 8px; transition: color .2s; }
  .choice-cancel-btn:hover { color: #cc7452; }

  /* Info Card Style */
  .info-card {
    background: #ffffff; border: 1px solid #e8e5df; border-radius: 20px;
    padding: 32px; margin-bottom: 40px; box-shadow: 0 4px 20px rgba(27,32,46,.02);
  }
  .info-section { display: flex; gap: 32px; margin-bottom: 24px; }
  .info-block { flex: 1; text-align: left; }
  .info-block h2 { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 700; color: #1b202e; margin-bottom: 12px; }
  .info-block p { font-size: 13px; color: #6b7080; line-height: 1.6; margin-bottom: 8px; }
  .info-block strong { color: #1b202e; }
  .info-divider { width: 1px; background: #e8e5df; align-self: stretch; }
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
  .usage-bar-track { height: 8px; background: #e8e5df; border-radius: 99px; overflow: hidden; margin-top: 8px; }
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

  /* Upload Progress Overlay */
  .upload-overlay {
    position: fixed; inset: 0; z-index: 500;
    background: rgba(250, 249, 246, 0.8);
    backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center;
  }
  .upload-card {
    background: #ffffff; border: 1px solid #e8e5df; border-radius: 24px;
    padding: 40px; width: 360px; text-align: center;
    box-shadow: 0 12px 40px rgba(27,32,46,.06);
  }
  .upload-card h3 {
    font-family: 'Playfair Display', serif; font-size: 18px; font-weight: 700;
    color: #1b202e; margin-bottom: 20px;
  }
  .upload-progress-track {
    height: 8px; background: #e8e5df; border-radius: 99px;
    overflow: hidden; margin-bottom: 12px;
  }
  .upload-progress-fill {
    height: 100%; background: #2b5c4f; border-radius: 99px;
    transition: width 0.2s ease;
  }
  .upload-percentage {
    font-family: 'DM Mono', monospace; font-size: 14px; font-weight: 700;
    color: #2b5c4f; display: block; margin-bottom: 16px;
  }
  .upload-card p {
    font-size: 11px; color: #6b7080; line-height: 1.5;
  }

  /* Reader Screen - 100% 정중앙 완벽 중앙 정렬 배치 */
  .reader-screen {
    height: 100dvh; width: 100vw; background: #faf9f6;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    position: relative; font-family: 'Outfit', sans-serif;
    overflow: hidden; padding: 0; margin: 0;
  }
  .reader-close {
    position: fixed; top: 16px; left: 16px; z-index: 200;
    width: 38px; height: 38px; border-radius: 50%; border: 1px solid #e8e5df;
    background: rgba(255, 255, 255, 0.9);
    display: flex; align-items: center; justify-content: center;
    color: #1b202e; cursor: pointer; transition: all .2s;
    box-shadow: 0 4px 15px rgba(27,32,46,.06);
    backdrop-filter: blur(8px);
  }
  .reader-close:hover { background: #f7f4eb; color: #cc7452; border-color: #cc7452; }

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
  .loading-progress-val {
    font-family: 'DM Mono', monospace; font-size: 16px; font-weight: 700;
    color: #2b5c4f; margin-top: -12px; margin-bottom: 8px;
  }
  .loading-dots { display: flex; gap: 6px; }
  .loading-dots span {
    width: 4px; height: 4px; border-radius: 50%; background: #2b5c4f;
    animation: dot-pulse 1.2s ease-in-out infinite;
  }

  /* Reader toolbar */
  .reader-toolbar {
    position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
    z-index: 200; display: flex; align-items: center; gap: 6px;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(232, 229, 223, 0.8); border-radius: 20px;
    padding: 4px 12px; height: 48px;
    box-shadow: 0 10px 30px rgba(27,32,46,.08);
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
    width: 64px; height: 34px; background: #faf9f6;
    border: 1px solid #e8e5df; border-radius: 8px;
    text-align: center; color: #2b5c4f; font-family: 'DM Mono', monospace;
    font-size: 12px; font-weight: 700; outline: none; transition: all .2s;
  }
  .tb-input:focus { border-color: #2b5c4f; background: #ffffff; }
  .tb-input::placeholder { color: #6b7080; }
  .tb-jump-btn {
    width: 30px; height: 30px; border-radius: 8px; background: #2b5c4f; border: none; color: #ffffff;
    display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .15s;
  }
  .tb-jump-btn:hover { background: #347060; }
  .tb-jump-btn:active { transform: scale(.9); }
  .tb-total { font-family: 'DM Mono', monospace; font-size: 10px; color: #6b7080; white-space: nowrap; font-weight: 700; }
`;