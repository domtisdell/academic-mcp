import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { parseString } from 'xml2js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const parseXML = promisify(parseString);

export class PDFUtils {
  private static instance: PDFUtils;
  private downloadsDir: string;

  private constructor() {
    this.downloadsDir = path.join(os.tmpdir(), 'science_mcp_downloads');
    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }
  }

  static getInstance(): PDFUtils {
    if (!PDFUtils.instance) {
      PDFUtils.instance = new PDFUtils();
    }
    return PDFUtils.instance;
  }

  async downloadPDF(pdfUrl: string, filename?: string, isRetry: boolean = false): Promise<string> {
    try {
      const response = await axios.get(pdfUrl, { 
        responseType: 'arraybuffer',
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ScienceMCP/1.0)'
        }
      });
      
      // Create filename from URL if not provided
      if (!filename) {
        const urlParts = pdfUrl.split('/');
        let baseFilename = urlParts[urlParts.length - 1];
        
        // Handle different URL patterns
        if (baseFilename.includes('arxiv.org')) {
          const arxivId = pdfUrl.match(/arxiv\.org\/pdf\/([^\/]+)/)?.[1] || 'unknown';
          baseFilename = `arxiv_${arxivId}`;
        } else if (baseFilename.includes('scholar.google')) {
          baseFilename = `scholar_${Date.now()}`;
        } else {
          baseFilename = baseFilename.replace('.pdf', '') || `paper_${Date.now()}`;
        }
        
        filename = `${baseFilename}.pdf`;
      }
      
      // Ensure filename has .pdf extension
      if (!filename.endsWith('.pdf')) {
        filename += '.pdf';
      }
      
      // Sanitize filename
      filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      
      const filepath = path.join(this.downloadsDir, filename);
      
      // Write PDF to file
      fs.writeFileSync(filepath, response.data);
      
      // Validate it's actually a PDF file
      if (!this.isValidPDF(filepath)) {
        fs.unlinkSync(filepath); // Clean up invalid file
        throw new Error('Downloaded file is not a valid PDF');
      }
      
      console.error(`PDF downloaded successfully: ${filepath}`);
      return filepath;
      
    } catch (error) {
      console.error('Error downloading PDF:', error);
      
      // Check if this is a paywalled source that we should try to find on ArXiv (but only if not already a retry)
      if (!isRetry && this.isPaywalledSource(pdfUrl)) {
        console.error('Detected paywalled source, attempting to find paper on ArXiv...');
        
        const paperTitle = this.extractTitleFromUrl(pdfUrl, filename);
        if (paperTitle) {
          try {
            const arxivPdfUrl = await this.findPaperOnArxiv(paperTitle);
            if (arxivPdfUrl) {
              console.error(`Found paper on ArXiv: ${arxivPdfUrl}`);
              return await this.downloadPDF(arxivPdfUrl, filename, true);
            }
          } catch (arxivError) {
            console.error('Failed to find paper on ArXiv:', arxivError);
          }
        }
      }
      
      throw new Error(`Failed to download PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private isValidPDF(filepath: string): boolean {
    try {
      const buffer = fs.readFileSync(filepath);
      // Check PDF magic number (first 4 bytes should be %PDF)
      return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === '%PDF';
    } catch {
      return false;
    }
  }

  private isPaywalledSource(url: string): boolean {
    const paywalledDomains = [
      'scholar.google.com',
      'sciencedirect.com',
      'ieee.org',
      'acm.org',
      'springer.com',
      'wiley.com',
      'tandfonline.com',
      'sagepub.com',
      'taylorfrancis.com',
      'emerald.com',
      'jstor.org'
    ];
    
    return paywalledDomains.some(domain => url.includes(domain));
  }

  private async findPaperOnArxiv(title: string): Promise<string | null> {
    try {
      // Direct HTTP request to ArXiv API
      const searchQuery = `ti:"${title}"`;
      const params = new URLSearchParams({
        search_query: searchQuery,
        start: '0',
        max_results: '5',
        sortBy: 'relevance',
        sortOrder: 'descending'
      });

      const response = await axios.get(`http://export.arxiv.org/api/query?${params}`);
      const xmlData = await parseXML(response.data) as any;

      if (!xmlData.feed || !xmlData.feed.entry) {
        // Try without quotes
        const fallbackQuery = title.replace(/[^\w\s]/g, ' ').trim();
        const fallbackParams = new URLSearchParams({
          search_query: fallbackQuery,
          start: '0',
          max_results: '5',
          sortBy: 'relevance',
          sortOrder: 'descending'
        });

        const fallbackResponse = await axios.get(`http://export.arxiv.org/api/query?${fallbackParams}`);
        const fallbackXmlData = await parseXML(fallbackResponse.data) as any;

        if (!fallbackXmlData.feed || !fallbackXmlData.feed.entry) {
          return null;
        }

        const entries = Array.isArray(fallbackXmlData.feed.entry) ? fallbackXmlData.feed.entry : [fallbackXmlData.feed.entry];
        if (entries.length > 0) {
          return entries[0].link.find((link: any) => link.$.type === 'application/pdf')?.$.href || null;
        }
        return null;
      }

      const entries = Array.isArray(xmlData.feed.entry) ? xmlData.feed.entry : [xmlData.feed.entry];
      if (entries.length > 0) {
        return entries[0].link.find((link: any) => link.$.type === 'application/pdf')?.$.href || null;
      }
      
      return null;
      
    } catch (error) {
      console.error('Error searching ArXiv for paper:', error);
      return null;
    }
  }

  private extractTitleFromUrl(url: string, filename?: string): string | null {
    // Try to extract title from filename first
    if (filename) {
      const cleanFilename = filename.replace(/\.pdf$/, '').replace(/[_-]/g, ' ');
      if (cleanFilename.length > 10) {
        return cleanFilename;
      }
    }
    
    // Try to extract from URL parameters
    try {
      const urlObj = new URL(url);
      const titleParam = urlObj.searchParams.get('title') || 
                        urlObj.searchParams.get('q') || 
                        urlObj.searchParams.get('query');
      if (titleParam) {
        return decodeURIComponent(titleParam);
      }
    } catch (error) {
      // URL parsing failed, continue with other methods
    }
    
    // Try to extract from URL path
    const pathParts = url.split('/');
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.length > 10 && !lastPart.includes('.')) {
      return lastPart.replace(/[_-]/g, ' ');
    }
    
    return null;
  }

  async readPDFText(filepath: string, startPage?: number, endPage?: number): Promise<string> {
    try {
      // Check if file exists
      if (!fs.existsSync(filepath)) {
        throw new Error(`PDF file not found: ${filepath}`);
      }

      // Read PDF file as Uint8Array
      const data = new Uint8Array(fs.readFileSync(filepath));

      // Load the PDF document (disableWorker for Node.js compatibility)
      const loadingTask = getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true });
      const pdfDocument = await loadingTask.promise;

      const totalPages = pdfDocument.numPages;
      const start = startPage || 1;
      const end = endPage || totalPages;

      const textParts: string[] = [];

      // Extract text from each page
      for (let pageNum = start; pageNum <= Math.min(end, totalPages); pageNum++) {
        const page = await pdfDocument.getPage(pageNum);
        const textContent = await page.getTextContent();

        // Combine text items, preserving some structure
        let lastY: number | null = null;
        const pageText: string[] = [];

        for (const item of textContent.items) {
          if ('str' in item) {
            const text = item.str;
            const transform = item.transform;
            const y = transform ? transform[5] : 0;

            // Add newline if Y position changed significantly (new line)
            if (lastY !== null && Math.abs(y - lastY) > 5) {
              pageText.push('\n');
            }

            pageText.push(text);
            lastY = y;
          }
        }

        textParts.push(`--- Page ${pageNum} ---\n${pageText.join(' ')}`);
      }

      return textParts.join('\n\n');

    } catch (error) {
      console.error('Error reading PDF:', error);
      throw new Error(`Failed to read PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async readPDFTextChunked(filepath: string, chunkSize: number = 10): Promise<{ chunks: string[], totalPages: number }> {
    try {
      // Check if file exists
      if (!fs.existsSync(filepath)) {
        throw new Error(`PDF file not found: ${filepath}`);
      }

      // Read PDF file and get total pages using pdfjs-dist
      const data = new Uint8Array(fs.readFileSync(filepath));
      const loadingTask = getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true });
      const pdfDocument = await loadingTask.promise;
      const totalPages = pdfDocument.numPages;

      if (totalPages === 0) {
        throw new Error('Could not determine PDF page count');
      }

      const chunks: string[] = [];

      // Read PDF in chunks
      for (let startPage = 1; startPage <= totalPages; startPage += chunkSize) {
        const endPage = Math.min(startPage + chunkSize - 1, totalPages);
        const chunkText = await this.readPDFText(filepath, startPage, endPage);
        chunks.push(chunkText);
      }

      return { chunks, totalPages };

    } catch (error) {
      console.error('Error reading PDF in chunks:', error);
      throw new Error(`Failed to read PDF in chunks: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async downloadAndReadPDF(pdfUrl: string, filename?: string): Promise<{ filepath: string; text: string }> {
    const filepath = await this.downloadPDF(pdfUrl, filename);
    const text = await this.readPDFText(filepath);
    return { filepath, text };
  }

  async getPDFPageCount(filepath: string): Promise<number> {
    try {
      if (!fs.existsSync(filepath)) {
        throw new Error(`PDF file not found: ${filepath}`);
      }

      const data = new Uint8Array(fs.readFileSync(filepath));
      const loadingTask = getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true });
      const pdfDocument = await loadingTask.promise;
      return pdfDocument.numPages;
    } catch (error) {
      console.error('Error getting PDF page count:', error);
      throw new Error(`Failed to get PDF page count: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  getDownloadsDirectory(): string {
    return this.downloadsDir;
  }

  listDownloadedPDFs(): string[] {
    try {
      return fs.readdirSync(this.downloadsDir)
        .filter(file => file.endsWith('.pdf'))
        .map(file => path.join(this.downloadsDir, file));
    } catch (error) {
      console.error('Error listing downloaded PDFs:', error);
      return [];
    }
  }

  cleanupDownloads(): void {
    try {
      const files = fs.readdirSync(this.downloadsDir);
      files.forEach(file => {
        const filepath = path.join(this.downloadsDir, file);
        fs.unlinkSync(filepath);
      });
      console.error(`Cleaned up ${files.length} downloaded files`);
    } catch (error) {
      console.error('Error cleaning up downloads:', error);
    }
  }
}