(function installOcrEngine(root) {
  'use strict';

  const MAX_OCR_PAGES = 8;
  const MAX_PAGE_PIXELS = 8_000_000;
  const MAX_TOTAL_PIXELS = 32_000_000;
  const MAX_OCR_ATTEMPTS = 10;
  const WORKER_TIMEOUT_MS = 30_000;
  const PAGE_TIMEOUT_MS = 45_000;
  const MIN_ROTATION_CONFIDENCE = 55;
  const MIN_ROTATION_TEXT_CHARS = 24;

  function assetUrl(relativePath) {
    if (root.chrome?.runtime?.id) return root.chrome.runtime.getURL(relativePath.replace(/^\.\.\//, ''));
    return new URL(relativePath, root.location.href).href;
  }

  function boundedDimensions(width, height, maxPixels = MAX_PAGE_PIXELS) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const scale = Math.min(1, Math.sqrt(maxPixels / (safeWidth * safeHeight)));
    return {
      width: Math.max(1, Math.round(safeWidth * scale)),
      height: Math.max(1, Math.round(safeHeight * scale)),
      scale,
      pixels: Math.max(1, Math.round(safeWidth * scale) * Math.round(safeHeight * scale)),
    };
  }

  function createCanvas(width, height) {
    const canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!context) throw new Error('This browser could not create an OCR canvas.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    return { canvas, context };
  }

  async function imageFileSource(file) {
    if (!root.createImageBitmap) throw new Error('This Chrome version cannot prepare images for on-device OCR.');
    const bitmap = await root.createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const dimensions = boundedDimensions(bitmap.width, bitmap.height);
      const { canvas, context } = createCanvas(dimensions.width, dimensions.height);
      context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
      return canvas;
    } finally {
      bitmap.close?.();
    }
  }

  async function pdfPageSource(page) {
    const base = page.getViewport({ scale: 1 });
    const desiredScale = 2;
    const dimensions = boundedDimensions(base.width * desiredScale, base.height * desiredScale);
    const scale = desiredScale * dimensions.scale;
    const viewport = page.getViewport({ scale });
    const { canvas, context } = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return canvas;
  }

  function rotateCanvas(source, degrees) {
    if (!degrees) return source;
    const sideways = Math.abs(degrees) % 180 === 90;
    const { canvas, context } = createCanvas(sideways ? source.height : source.width, sideways ? source.width : source.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((degrees * Math.PI) / 180);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    return canvas;
  }

  function average(values) {
    const usable = values.map(Number).filter(Number.isFinite);
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
  }

  function normalizeBbox(bbox) {
    if (!bbox) return null;
    const values = ['x0', 'y0', 'x1', 'y1'].map((key) => Number(bbox[key]));
    if (!values.every(Number.isFinite)) return null;
    return { x0: values[0], y0: values[1], x1: values[2], y1: values[3] };
  }

  function linesFromResult(data) {
    const lines = [];
    (data?.blocks || []).forEach((block) => {
      (block.paragraphs || []).forEach((paragraph) => {
        (paragraph.lines || []).forEach((line) => {
          const text = String(line.text || (line.words || []).map((word) => word.text || '').join(' ')).trim();
          if (!text) return;
          lines.push({
            text,
            confidence: Number.isFinite(Number(line.confidence)) ? Number(line.confidence) : average((line.words || []).map((word) => word.confidence)),
            bbox: normalizeBbox(line.bbox),
          });
        });
      });
    });
    if (!lines.length) {
      String(data?.text || '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean).forEach((text) => {
        lines.push({ text, confidence: Number(data?.confidence) || null, bbox: null });
      });
    }
    return lines;
  }

  function withTimeout(promise, milliseconds, message, onTimeout) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* best-effort cleanup */ }
        reject(new Error(message));
      }, milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function createWorker(onProgress = () => {}) {
    const tesseractModule = await import(assetUrl('../vendor/tesseract/tesseract.esm.min.js'));
    const tesseract = tesseractModule.default || tesseractModule;
    let lastStatus = '';
    let lastProgress = -1;
    const workerPromise = tesseract.createWorker('eng', tesseract.OEM.LSTM_ONLY, {
      workerPath: assetUrl('../vendor/tesseract/worker.min.js'),
      corePath: assetUrl('../vendor/tesseract/core'),
      langPath: assetUrl('../vendor/tesseract/lang-data'),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger(message) {
        const progress = Number(message.progress) || 0;
        if (message.status !== lastStatus || progress - lastProgress >= 0.05 || progress === 1) {
          lastStatus = message.status;
          lastProgress = progress;
          onProgress({ stage: 'ocr', status: message.status, progress });
        }
      },
    });
    try {
      return await withTimeout(workerPromise, WORKER_TIMEOUT_MS, 'The on-device OCR engine took too long to start.', () => {
        workerPromise.then((worker) => worker.terminate()).catch(() => undefined);
      });
    } catch (error) {
      throw new Error(`On-device OCR could not start. ${error.message}`);
    }
  }

  function resultScore(result) {
    const confidence = Number(result.confidence) || 0;
    const characters = String(result.text || '').replace(/\s/g, '').length;
    return confidence * 1000 + Math.min(characters, 999);
  }

  async function recognizeAttempt(worker, sourceCanvas, rotation, context, budget) {
    if (budget.attempts >= MAX_OCR_ATTEMPTS) throw new Error('The OCR attempt limit was reached.');
    const canvas = rotateCanvas(sourceCanvas, rotation);
    const pixels = canvas.width * canvas.height;
    if (pixels > MAX_PAGE_PIXELS || budget.pixels + pixels > MAX_TOTAL_PIXELS) {
      if (canvas !== sourceCanvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      throw new Error('The OCR pixel safety limit was reached.');
    }
    budget.attempts += 1;
    budget.pixels += pixels;
    context.onProgress({ stage: 'ocr', status: 'recognizing text', progress: 0, pageNumber: context.pageNumber, totalPages: context.totalPages, rotation });
    try {
      const response = await withTimeout(
        worker.recognize(canvas, {
          tessedit_pageseg_mode: '11',
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
        }, { text: true, blocks: true }),
        PAGE_TIMEOUT_MS,
        `OCR timed out on page ${context.pageNumber}.`,
        () => worker.terminate(),
      );
      return {
        pageNumber: context.pageNumber,
        text: String(response?.data?.text || '').slice(0, 120_000),
        confidence: Number(response?.data?.confidence) || 0,
        lines: linesFromResult(response?.data),
        width: canvas.width,
        height: canvas.height,
        rotation,
      };
    } finally {
      if (canvas !== sourceCanvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
  }

  async function recognizeSource(worker, source, context, budget) {
    const canvas = await source.render();
    try {
      const attempts = [await recognizeAttempt(worker, canvas, 0, context, budget)];
      const first = attempts[0];
      const weak = first.confidence < MIN_ROTATION_CONFIDENCE
        || first.text.replace(/\s/g, '').length < MIN_ROTATION_TEXT_CHARS;
      if (weak && source.allowRotation !== false) {
        for (const rotation of [90, 270]) {
          if (budget.attempts >= MAX_OCR_ATTEMPTS || budget.pixels + canvas.width * canvas.height > MAX_TOTAL_PIXELS) break;
          attempts.push(await recognizeAttempt(worker, canvas, rotation, context, budget));
        }
      }
      return attempts.sort((left, right) => resultScore(right) - resultScore(left))[0];
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  async function recognizeSources(sources, { onProgress = () => {} } = {}) {
    const limitedSources = sources.slice(0, MAX_OCR_PAGES);
    const warnings = [];
    const pages = [];
    const budget = { pixels: 0, attempts: 0 };
    const startedAt = Date.now();
    let worker;
    try {
      onProgress({ stage: 'ocr', status: 'loading on-device OCR', progress: 0, totalPages: limitedSources.length });
      worker = await createWorker(onProgress);
      for (let index = 0; index < limitedSources.length; index += 1) {
        const source = limitedSources[index];
        try {
          const page = await recognizeSource(worker, source, {
            onProgress,
            pageNumber: source.pageNumber || index + 1,
            totalPages: limitedSources.length,
          }, budget);
          pages.push(page);
          onProgress({ stage: 'ocr', status: 'page complete', progress: (index + 1) / limitedSources.length, pageNumber: page.pageNumber, totalPages: limitedSources.length });
        } catch (error) {
          warnings.push(error.message);
          if (/timed out|attempt limit|pixel safety limit/i.test(error.message)) break;
        }
      }
    } finally {
      await worker?.terminate().catch(() => undefined);
    }
    if (sources.length > MAX_OCR_PAGES) warnings.push(`Only the first ${MAX_OCR_PAGES} image-only pages were sent through OCR.`);
    return {
      pages,
      warnings,
      metrics: {
        pagesRequested: sources.length,
        pagesProcessed: pages.length,
        attempts: budget.attempts,
        pixelsProcessed: budget.pixels,
        durationMs: Date.now() - startedAt,
        averageConfidence: average(pages.map((page) => page.confidence)),
      },
    };
  }

  const api = {
    LIMITS: {
      maxPages: MAX_OCR_PAGES,
      maxPagePixels: MAX_PAGE_PIXELS,
      maxTotalPixels: MAX_TOTAL_PIXELS,
      maxAttempts: MAX_OCR_ATTEMPTS,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      pageTimeoutMs: PAGE_TIMEOUT_MS,
    },
    boundedDimensions,
    imageFileSource,
    linesFromResult,
    pdfPageSource,
    recognizeSources,
  };

  root.NavaOcrEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
