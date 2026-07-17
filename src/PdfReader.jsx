import React, { useState, useRef, useEffect } from 'react';
import HTMLFlipBook from 'react-pageflip';
import * as pdfjsLib from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, Loader2, Upload, BookOpen, AlertCircle, Maximize2 } from 'lucide-react';

/** * [무적 설정] 로컬 워커 사용으로 404 에러 방지
 */
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const PdfReader = () => {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorLog, setErrorLog] = useState("");
  const bookRef = useRef(null);

  // 전체 화면 토글 함수
  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        alert(`전체 화면 전환 실패: ${err.message}`);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  const onFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    setFileName(file.name);
    setErrorLog("");
    
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const typedarray = new Uint8Array(reader.result);
        const loadingTask = pdfjsLib.getDocument({
          data: typedarray,
          cMapUrl: 'https://unpkg.com/pdfjs-dist@5.5.207/cmaps/', 
          cMapPacked: true,
        });

        const pdf = await loadingTask.promise;
        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
      } catch (err) {
        console.error("로딩 에러:", err);
        setErrorLog(err.message);
      }
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
  };

  const Page = React.forwardRef((props, ref) => {
    const canvasRef = useRef(null);
    const [rendered, setRendered] = useState(false);

    useEffect(() => {
      let isMounted = true;
      const renderPage = async () => {
        if (!pdfDoc || rendered || !isMounted) return;
        
        try {
          const page = await pdfDoc.getPage(props.number);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = canvasRef.current;
          if (!canvas) return;

          const context = canvas.getContext('2d');
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({ canvasContext: context, viewport }).promise;
          if (isMounted) setRendered(true);
        } catch (err) {
          console.error("렌더링 에러:", err);
        }
      };

      const timer = setTimeout(renderPage, 200);
      return () => { 
        isMounted = false;
        clearTimeout(timer);
      };
    }, [pdfDoc, props.number, rendered]);

    return (
      <div className="bg-white border-l shadow-inner w-full h-full relative" ref={ref}>
        <canvas ref={canvasRef} className="w-full h-full object-contain px-2" />
        {!rendered && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-100 text-zinc-400">
            <Loader2 className="animate-spin mb-2" size={24} />
            <span className="text-[10px] font-bold tracking-widest uppercase">Loading...</span>
          </div>
        )}
      </div>
    );
  });

  return (
    <div className="flex flex-col items-center justify-start min-h-screen bg-zinc-950 text-white p-4 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <div className="w-full max-w-6xl flex justify-between items-center p-5 bg-zinc-900/80 backdrop-blur-md rounded-[2rem] border border-white/5 mb-8 shadow-2xl">
        <div className="flex items-center gap-4 px-2">
          <div className="w-12 h-12 bg-gradient-to-tr from-blue-600 to-emerald-500 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <BookOpen className="text-white" size={24} />
          </div>
          <div className="flex flex-col">
            <span className="font-black text-xl tracking-tighter leading-none mb-1">VIBE READER</span>
            <span className="text-[10px] text-emerald-500 font-black uppercase tracking-[0.3em]">Pro Edition</span>
          </div>
        </div>
        
        <label className="bg-emerald-500 hover:bg-emerald-400 text-black px-8 py-3.5 rounded-2xl font-black cursor-pointer transition-all active:scale-95 shadow-lg shadow-emerald-500/20">
          교재 업로드
          <input type="file" accept="application/pdf" className="hidden" onChange={onFileChange} />
        </label>
      </div>

      {loading && (
        <div className="mt-40 flex flex-col items-center">
          <Loader2 className="animate-spin text-emerald-500" size={64} strokeWidth={3} />
          <p className="mt-10 text-zinc-200 font-black text-2xl tracking-tight uppercase">Analyzing...</p>
        </div>
      )}

      {errorLog && (
        <div className="mt-40 p-10 bg-red-500/5 border border-red-500/20 rounded-[2.5rem] text-center max-w-lg">
          <AlertCircle className="mx-auto text-red-500 mb-6" size={64} />
          <p className="text-red-300/60 text-xs font-mono p-5 bg-black/40 rounded-2xl">{errorLog}</p>
        </div>
      )}

      {pdfDoc && (
        <div className="flex flex-col items-center animate-in fade-in slide-in-from-bottom-10 duration-1000">
          <div className="shadow-[0_60px_150px_-20px_rgba(0,0,0,1)] rounded-sm overflow-hidden border border-white/5 bg-zinc-900">
            <HTMLFlipBook 
              width={500} 
              height={700} 
              size="stretch"
              showCover={true}
              ref={bookRef}
              useMouseEvents={true}
              className="digital-textbook"
              flippingTime={800}
            >
              {[...Array(numPages)].map((_, i) => (
                <Page key={i} number={i + 1} />
              ))}
            </HTMLFlipBook>
          </div>

          {/* Navigation with Fullscreen Button */}
          <div className="fixed bottom-10 flex items-center gap-6 bg-zinc-900/90 backdrop-blur-3xl px-10 py-6 rounded-[2.5rem] border border-white/10 shadow-3xl">
            {/* 이전 버튼 */}
            <button onClick={() => bookRef.current.pageFlip().flipPrev()} className="text-zinc-500 hover:text-white transition-all active:scale-75">
              <ChevronLeft size={40} strokeWidth={2.5} />
            </button>

            {/* [추가] 전체 화면 토글 버튼 */}
            <button 
              onClick={toggleFullScreen} 
              className="p-3 bg-white/5 hover:bg-emerald-500/20 rounded-2xl transition-all group border border-white/5"
              title="전체 화면 보기"
            >
              <Maximize2 size={24} className="text-emerald-400 group-hover:scale-110 transition-transform" />
            </button>

            {/* 책 정보 */}
            <div className="flex flex-col items-center min-w-[180px] px-6 border-x border-white/5">
              <span className="text-[10px] text-zinc-500 font-black uppercase tracking-[0.3em] mb-1">Textbook</span>
              <span className="text-sm font-bold text-zinc-100 truncate max-w-[180px] mb-1">{fileName}</span>
              <div className="px-3 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20">
                 <span className="text-[10px] text-emerald-400 font-black tracking-widest uppercase">{numPages} Pages</span>
              </div>
            </div>

            {/* 다음 버튼 */}
            <button onClick={() => bookRef.current.pageFlip().flipNext()} className="text-zinc-500 hover:text-white transition-all active:scale-75">
              <ChevronRight size={40} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}

      {!loading && !pdfDoc && !errorLog && (
        <div className="mt-40 text-center">
          <BookOpen size={110} className="mx-auto mb-10 text-zinc-900 opacity-20" />
          <p className="text-3xl font-black text-zinc-800 tracking-tighter uppercase">Ready to Read</p>
          <p className="text-zinc-800/40 mt-3 font-bold">PDF 파일을 선택하면 나만의 몰입형 서재가 열립니다.</p>
        </div>
      )}
    </div>
  );
};

export default PdfReader;