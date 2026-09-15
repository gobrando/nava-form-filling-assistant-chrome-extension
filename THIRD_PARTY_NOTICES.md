# Third-party notices

This prototype vendors browser builds of these open-source libraries:

- **PDF.js** (`vendor/pdf.min.mjs`, `vendor/pdf.worker.min.mjs`) — Apache License 2.0. The complete license text is in `vendor/licenses/PDFJS-LICENSE.txt`.
- **fflate** (`vendor/fflate.min.js`) — MIT License. The complete license text is in `vendor/licenses/FFLATE-LICENSE.txt`.
- **Tesseract.js 7.0.0** (`vendor/tesseract/tesseract.esm.min.js`, `vendor/tesseract/worker.min.js`) — Apache License 2.0. The complete license text is in `vendor/licenses/TESSERACT-JS-LICENSE.txt`.
- **tesseract.js-core 7.0.0** (`vendor/tesseract/core/`) — Apache License 2.0. The complete license text is in `vendor/licenses/TESSERACT-CORE-LICENSE.txt`.
- **tessdata_fast English model** (`vendor/tesseract/lang-data/eng.traineddata.gz`) — Apache License 2.0. The complete license text is in `vendor/licenses/TESSDATA-FAST-LICENSE.txt`. The pinned file's SHA-256 digest is `18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b`.

The libraries and language model run entirely inside the extension. No parser or OCR asset is loaded from a CDN.
