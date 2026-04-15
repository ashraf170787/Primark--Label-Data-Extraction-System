import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  
  // 1. Merge PDFs
  app.post('/api/merge', upload.array('pdfs'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length < 2) {
        return res.status(400).json({ error: 'Please upload at least two PDF files.' });
      }

      const mergedPdf = await PDFDocument.create();
      
      for (const file of files) {
        const pdf = await PDFDocument.load(file.buffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }

      const pdfBytes = await mergedPdf.save();
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=merged.pdf');
      res.send(Buffer.from(pdfBytes));
    } catch (error) {
      console.error('Merge error:', error);
      res.status(500).json({ error: 'Failed to merge PDFs. Ensure files are valid and not corrupted.' });
    }
  });

  // 2. Extract Table to Excel (Moved to Frontend per guidelines)
  // This endpoint is no longer needed for Gemini calls, but we'll keep it as a placeholder 
  // or remove it if we handle everything on the client.
  // For now, let's just remove the Gemini code to fix the lint error.

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
