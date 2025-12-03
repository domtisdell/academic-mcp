import axios from 'axios';
import { PDFUtils } from './pdf-utils.js';

export interface ScholarPaper {
  title: string;
  authors: string[];
  abstract: string;
  year: string;
  venue: string;
  citedBy: number;
  url: string;
  pdfUrl?: string;
}

// Using Semantic Scholar API instead of Google Scholar (which blocks automated requests)
export class GoogleScholarClient {
  private baseUrl = 'https://api.semanticscholar.org/graph/v1';
  private pdfUtils = PDFUtils.getInstance();

  async searchPapers(query: string, maxResults: number = 10, sortBy: 'relevance' | 'date' = 'relevance'): Promise<ScholarPaper[]> {
    try {
      const params = new URLSearchParams({
        query: query,
        limit: maxResults.toString(),
        fields: 'title,authors,abstract,year,venue,citationCount,url,openAccessPdf'
      });

      const response = await axios.get(`${this.baseUrl}/paper/search?${params}`, {
        headers: {
          'Accept': 'application/json'
        },
        timeout: 15000
      });

      const papers: ScholarPaper[] = [];

      if (response.data && response.data.data) {
        for (const paper of response.data.data) {
          papers.push({
            title: paper.title || '',
            authors: paper.authors?.map((a: any) => a.name) || [],
            abstract: paper.abstract || '',
            year: paper.year?.toString() || '',
            venue: paper.venue || '',
            citedBy: paper.citationCount || 0,
            url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
            pdfUrl: paper.openAccessPdf?.url || undefined
          });
        }
      }

      // Sort by date if requested
      if (sortBy === 'date') {
        papers.sort((a, b) => parseInt(b.year || '0') - parseInt(a.year || '0'));
      }

      return papers;
    } catch (error) {
      console.error('Error searching Semantic Scholar:', error);
      return [];
    }
  }

  async getLatestPapers(topic: string, maxResults: number = 10): Promise<ScholarPaper[]> {
    return this.searchPapers(topic, maxResults, 'date');
  }

  async searchByTopic(topic: string, maxResults: number = 10): Promise<ScholarPaper[]> {
    return this.searchPapers(topic, maxResults, 'relevance');
  }

  async downloadPDF(pdfUrl: string, filename?: string): Promise<string> {
    return this.pdfUtils.downloadPDF(pdfUrl, filename);
  }

  async readPDFText(filepath: string): Promise<string> {
    return this.pdfUtils.readPDFText(filepath);
  }

  async downloadAndReadPDF(pdfUrl: string, filename?: string): Promise<{ filepath: string; text: string }> {
    return this.pdfUtils.downloadAndReadPDF(pdfUrl, filename);
  }
}