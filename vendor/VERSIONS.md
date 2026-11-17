# Vendored libraries

Copied unmodified from the npm registry tarballs. Each tarball was checked against the
registry's `dist.integrity` (sha512) before extraction. They are served with the app so
that everything works offline. They are loaded only when needed: pdf.js for a PDF receipt,
Tesseract for reading a photo.

| Library | Version | License | Files taken | Used for |
|---|---|---|---|---|
| [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) (Mozilla pdf.js) | 6.5.438 | Apache-2.0 | `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `LICENSE` | rendering PDF receipt pages to images; reading their text |
| [tesseract.js](https://www.npmjs.com/package/tesseract.js) | 7.0.0 | Apache-2.0 | `dist/tesseract.esm.min.js`, `dist/worker.min.js`, `LICENSE.md` → `LICENSE` | OCR of receipt photos |
| [tesseract.js-core](https://www.npmjs.com/package/tesseract.js-core) | 7.0.0 | Apache-2.0 | `tesseract-core-simd-lstm.wasm.js` | Tesseract engine (WebAssembly SIMD build, LSTM only) |
| [@tesseract.js-data/fra](https://www.npmjs.com/package/@tesseract.js-data/fra) | 1.0.0 | MIT (model: Apache-2.0, tesseract-ocr/tessdata) | `4.0.0_best_int/fra.traineddata.gz` → `lang/` | French recognition model |

Only the SIMD build of the Tesseract core is shipped. Every Chrome for Android since
version 91 (2021) supports WebAssembly SIMD.

To update, download the new tarballs, check their integrity, replace the files, update this
table, and run `node --test tests/` and the browser smoke test (see README).
