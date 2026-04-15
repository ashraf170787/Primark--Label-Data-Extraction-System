/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  FileText, 
  Table, 
  Merge, 
  Upload, 
  Download, 
  X, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  FilePlus,
  ArrowRight,
  ChevronRight,
  Info,
  Layout
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI } from "@google/genai";
import * as XLSX from 'xlsx';
import { jsonrepair } from 'jsonrepair';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Tab = 'extract' | 'merge';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('extract');
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Extract State
  const [extractFile, setExtractFile] = useState<File | null>(null);
  const [extractedData, setExtractedData] = useState<any>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [previewTableKey, setPreviewTableKey] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  // Merge State
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    if (activeTab === 'extract') {
      const file = files[0];
      if (file && file.type === 'application/pdf') {
        setExtractFile(file);
        setError(null);
      } else {
        setError('Please select a valid PDF file.');
      }
    } else {
      const newFiles = (Array.from(files) as File[]).filter(f => f.type === 'application/pdf');
      setMergeFiles(prev => [...prev, ...newFiles]);
      setError(null);
    }
    
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeMergeFile = (index: number) => {
    setMergeFiles(prev => prev.filter((_, i) => i !== index));
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handleExtract = async () => {
    if (!extractFile) return;
    
    setIsAnalyzing(true);
    setError(null);
    setSuccess(null);
    setExtractedData(null);
    setSelectedTables(new Set());
    setPreviewTableKey(null);

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('Gemini API key is not configured.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const pdfBase64 = await fileToBase64(extractFile);

      const prompt = `
        You are a highly accurate data extraction tool. Your goal is to identify and extract EVERY distinct table from the provided PDF.
        
        CRITICAL INSTRUCTIONS:
        1. Scan the entire document for tables. Do NOT stop after the first one.
        2. Return a JSON object where EACH distinct regional section is a separate key. You MUST identify and separate these 10 specific regions: "ROI", "GCC", "ROO", "NE1 - MGB", "NE2 - BOR", "IB", "UK", "UK Trial", "US1 - PA", and "US2 - FL".
        3. For each table, provide a FLAT array of objects representing the data rows. Do NOT include "Total" rows or summary rows; only extract the individual item/size rows.
        4. Add a "Region" column as the FIRST column in every row. The value MUST match the region name (e.g., "ROI", "GCC", etc.).
        5. Capture all headers accurately (SKU, Barcode, Kimball, Colour, Size, Price, etc.).
        6. If a table is split across pages or interrupted by text (like "Page 2" or "Total"), but has the same headers or belongs to the same section (like "NE2 - BOR"), you MUST merge all rows into a single array under that table's name.
        7. If tables have different headers, they MUST be separate keys in the JSON.
        8. Do NOT skip any data rows. Every row visible in the PDF must be captured.
        
        Return ONLY the raw JSON object. No markdown formatting.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: pdfBase64,
                  mimeType: 'application/pdf'
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          systemInstruction: "You are a professional data extraction assistant. Your task is to extract tables from PDF documents into a structured JSON format. Use concise keys for JSON objects to save space. Ensure all columns and rows are captured accurately."
        }
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error('AI failed to generate a response.');
      }

      let jsonString = responseText.replace(/```json|```/g, '').trim();
      
      let tableData;
      try {
        tableData = JSON.parse(jsonString);
      } catch (e) {
        try {
          const repairedJson = jsonrepair(jsonString);
          tableData = JSON.parse(repairedJson);
        } catch (repairError) {
          throw new Error('The document is too complex. Please try a smaller PDF.');
        }
      }

      // Normalize and flatten tableData
      let normalized: any = {};
      const flattenObject = (obj: any): any => {
        const flattened: any = {};
        if (typeof obj !== 'object' || obj === null) return { value: obj };
        for (const key in obj) {
          if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            Object.assign(flattened, flattenObject(obj[key]));
          } else {
            flattened[key] = obj[key];
          }
        }
        return flattened;
      };

      if (Array.isArray(tableData)) {
        // If it's a single array, check if it's an array of tables or an array of rows
        if (tableData.length > 0 && Array.isArray(tableData[0])) {
          tableData.forEach((table, idx) => {
            normalized[`Table ${idx + 1}`] = table.map(row => flattenObject(row));
          });
        } else {
          normalized = { "Extracted Table": tableData.map(row => flattenObject(row)) };
        }
      } else if (typeof tableData === 'object' && tableData !== null) {
        // Check if the object contains arrays (standard case)
        const keys = Object.keys(tableData);
        let foundArrays = false;
        for (const key of keys) {
          if (Array.isArray(tableData[key])) {
            normalized[key] = tableData[key].map((row: any) => flattenObject(row));
            foundArrays = true;
          }
        }
        
        // If no arrays found, maybe the whole object is one row
        if (!foundArrays) {
          normalized = { "Extracted Data": [flattenObject(tableData)] };
        }
      }

      if (Object.keys(normalized).length === 0) {
        throw new Error('No tables found in the document.');
      }

      setExtractedData(normalized);
      // Select all by default
      setSelectedTables(new Set(Object.keys(normalized)));
      setSuccess(`Found ${Object.keys(normalized).length} tables. Select which ones to extract.`);
    } catch (err: any) {
      console.error('Analysis error:', err);
      let message = err.message || 'An error occurred during analysis.';
      
      if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
        message = 'The AI service is currently busy or you have reached the usage limit. Please wait a minute and try again.';
      } else if (message.includes('API key')) {
        message = 'The AI service is not properly configured. Please check the API settings.';
      }
      
      setError(message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const downloadSelected = () => {
    if (!extractedData || selectedTables.size === 0) return;

    try {
      const wb = XLSX.utils.book_new();
      let added = false;

      selectedTables.forEach(key => {
        const data = extractedData[key];
        if (Array.isArray(data) && data.length > 0) {
          const ws = XLSX.utils.json_to_sheet(data);
          const sheetName = key.replace(/[\\/?*[\]]/g, '').substring(0, 31) || `Table`;
          XLSX.utils.book_append_sheet(wb, ws, sheetName);
          added = true;
        }
      });

      if (!added) throw new Error('No valid data to export.');

      XLSX.writeFile(wb, 'extracted_tables.xlsx');
      setSuccess('Excel file generated successfully!');
    } catch (err: any) {
      setError(err.message || 'Failed to generate Excel.');
    }
  };

  const toggleTableSelection = (key: string) => {
    setSelectedTables(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedTables.size === Object.keys(extractedData).length) {
      setSelectedTables(new Set());
    } else {
      setSelectedTables(new Set(Object.keys(extractedData)));
    }
  };

  const handleMerge = async () => {
    if (mergeFiles.length < 2) {
      setError('Please add at least two PDF files to merge.');
      return;
    }

    setIsUploading(true);
    setError(null);
    setSuccess(null);

    const formData = new FormData();
    mergeFiles.forEach(file => formData.append('pdfs', file));

    try {
      const response = await fetch('/api/merge', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Merge failed');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'merged_document.pdf';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      setSuccess('PDFs merged successfully! Your download should start shortly.');
    } catch (err: any) {
      setError(err.message || 'An error occurred during merging.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-primary-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-primary-200">
              <FileText size={24} />
            </div>
            <h1 className="text-xl font-display font-bold tracking-tight text-slate-900">
              PDF<span className="text-primary-600">Master</span>
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <nav className="hidden sm:flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
              <button
                onClick={() => setActiveTab('extract')}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                  activeTab === 'extract' ? "bg-white text-primary-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
                )}
              >
                Extract Tables
              </button>
              <button
                onClick={() => setActiveTab('merge')}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                  activeTab === 'merge' ? "bg-white text-primary-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
                )}
              >
                Merge PDFs
              </button>
            </nav>
          </div>
        </div>
      </header>

      <main className={cn("flex-1 mx-auto w-full px-4 py-12 transition-all duration-500", extractedData ? "max-w-6xl" : "max-w-3xl")}>
        <div className={cn("grid gap-12 transition-all duration-500", extractedData ? "lg:grid-cols-12" : "grid-cols-1")}>
          {/* Left Side: Table List (Only after analysis) */}
          <AnimatePresence mode="wait">
            {activeTab === 'extract' && extractedData && (
              <motion.div 
                key="analysis-results"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="lg:col-span-4 space-y-6"
              >
                <div className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-200 overflow-hidden sticky top-24">
                  <div className="p-6 space-y-6">
                    <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-100">
                      <h4 className="text-base font-bold text-emerald-900 flex items-center gap-2">
                        <CheckCircle2 size={18} className="text-emerald-500" />
                        Analysis Complete
                      </h4>
                      <p className="text-xs text-emerald-700 mt-1">Found <span className="font-bold">{Object.keys(extractedData).length} tables</span> in your document.</p>
                    </div>

                    <div className="space-y-3 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 sticky top-0 z-10">
                        <input 
                          type="checkbox" 
                          checked={selectedTables.size === Object.keys(extractedData).length}
                          onChange={toggleSelectAll}
                          className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="text-sm font-bold text-slate-700">Select All Tables</span>
                      </div>
                      
                      {Object.keys(extractedData).map((key) => (
                        <div 
                          key={key}
                          className={cn(
                            "flex items-center justify-between p-3 rounded-xl border transition-all",
                            previewTableKey === key ? "border-primary-300 bg-primary-50/30" : "border-slate-100 bg-white"
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <input 
                              type="checkbox" 
                              checked={selectedTables.has(key)}
                              onChange={() => toggleTableSelection(key)}
                              className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                            />
                            <div className="overflow-hidden">
                              <p className="text-sm font-bold text-slate-900 truncate max-w-[120px]">{key}</p>
                              <p className="text-[10px] text-slate-500">{extractedData[key].length} rows</p>
                            </div>
                          </div>
                          <button 
                            onClick={() => setPreviewTableKey(previewTableKey === key ? null : key)}
                            className={cn(
                              "px-2 py-1 rounded-lg text-[10px] font-bold transition-all",
                              previewTableKey === key 
                                ? "bg-primary-600 text-white" 
                                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                            )}
                          >
                            {previewTableKey === key ? "Hide" : "Preview"}
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="pt-4 border-t border-slate-100 space-y-3">
                      <button
                        disabled={selectedTables.size === 0}
                        onClick={downloadSelected}
                        className={cn(
                          "w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg text-sm",
                          selectedTables.size === 0
                            ? "bg-slate-100 text-slate-400 cursor-not-allowed" 
                            : "bg-primary-600 text-white hover:bg-primary-700 hover:shadow-primary-200"
                        )}
                      >
                        <Download size={18} />
                        Download ({selectedTables.size})
                      </button>
                      <button 
                        onClick={() => { setExtractedData(null); setExtractFile(null); }}
                        className="w-full py-2 text-xs font-bold text-slate-400 hover:text-slate-600 transition-all flex items-center justify-center gap-1"
                      >
                        <X size={14} /> Reset & Upload New
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Right Side: Tool or Preview */}
          <div className={cn("transition-all duration-500", extractedData ? "lg:col-span-8" : "col-span-1")}>
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-200 overflow-hidden min-h-[400px]"
            >
              <div className="p-8">
                {/* Mobile Tabs */}
                <div className="sm:hidden flex mb-8 bg-slate-100 p-1 rounded-xl">
                  <button
                    onClick={() => setActiveTab('extract')}
                    className={cn(
                      "flex-1 py-2 rounded-lg text-sm font-medium transition-all",
                      activeTab === 'extract' ? "bg-white text-primary-600 shadow-sm" : "text-slate-600"
                    )}
                  >
                    Extract
                  </button>
                  <button
                    onClick={() => setActiveTab('merge')}
                    className={cn(
                      "flex-1 py-2 rounded-lg text-sm font-medium transition-all",
                      activeTab === 'merge' ? "bg-white text-primary-600 shadow-sm" : "text-slate-600"
                    )}
                  >
                    Merge
                  </button>
                </div>

                {/* Dropzone (Only shown if no data or in merge tab) */}
                {(!extractedData || activeTab === 'merge') && (
                  <div 
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      "relative border-2 border-dashed rounded-2xl p-12 flex flex-col items-center justify-center text-center cursor-pointer transition-all group",
                      isAnalyzing ? "pointer-events-none opacity-50" : "hover:border-primary-400 hover:bg-primary-50/30",
                      (activeTab === 'extract' ? extractFile : mergeFiles.length > 0) ? "border-primary-200 bg-primary-50/10" : "border-slate-200"
                    )}
                  >
                    <input 
                      type="file" 
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      className="hidden"
                      accept="application/pdf"
                      multiple={activeTab === 'merge'}
                    />
                    
                    <div className="w-16 h-16 bg-primary-50 rounded-2xl flex items-center justify-center text-primary-600 mb-4 group-hover:scale-110 transition-transform">
                      {activeTab === 'extract' ? <Table size={32} /> : <FilePlus size={32} />}
                    </div>
                    <h4 className="text-lg font-bold text-slate-900 mb-1">
                      {activeTab === 'extract' ? "Select PDF to extract" : "Add PDFs to merge"}
                    </h4>
                    <p className="text-slate-500 text-sm">
                      Drag and drop or click to browse
                    </p>
                    <p className="text-xs text-slate-400 mt-4">
                      Supports files up to 50MB
                    </p>
                  </div>
                )}

                {/* Preview Table (Right Side) */}
                {activeTab === 'extract' && extractedData && (
                  <div className="space-y-6">
                    <AnimatePresence mode="wait">
                      {previewTableKey ? (
                        <motion.div 
                          key={previewTableKey}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="overflow-hidden border border-slate-200 rounded-2xl bg-white"
                        >
                          <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Table size={16} className="text-primary-600" />
                              <span className="text-sm font-bold text-slate-900">{previewTableKey}</span>
                            </div>
                            <span className="text-xs text-slate-500">Showing first 10 rows</span>
                          </div>
                          <div className="overflow-x-auto custom-scrollbar">
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="bg-slate-50/30">
                                  {Object.keys(extractedData[previewTableKey][0] || {}).map(col => (
                                    <th key={col} className="px-4 py-2 text-[10px] font-bold text-slate-500 uppercase border-b border-slate-100 whitespace-nowrap">
                                      {col}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {extractedData[previewTableKey].slice(0, 10).map((row: any, i: number) => (
                                  <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                                    {Object.values(row).map((val: any, j: number) => (
                                      <td key={j} className="px-4 py-2 text-xs text-slate-600 border-b border-slate-50 whitespace-nowrap">
                                        {typeof val === 'object' && val !== null 
                                          ? JSON.stringify(val).substring(0, 50) + (JSON.stringify(val).length > 50 ? '...' : '')
                                          : String(val || '')}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </motion.div>
                      ) : (
                        <motion.div 
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="flex flex-col items-center justify-center py-20 text-slate-400 border-2 border-dashed border-slate-100 rounded-3xl"
                        >
                          <Layout size={48} className="mb-4 opacity-20" />
                          <p className="text-sm font-medium">Select a table from the list to preview its data</p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* File List (For Merge or Initial Extract) */}
                <AnimatePresence>
                  {activeTab === 'extract' && extractFile && !extractedData && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="mt-6 p-4 bg-slate-50 rounded-xl flex items-center justify-between border border-slate-100"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center text-primary-600 shadow-sm">
                          <FileText size={20} />
                        </div>
                        <div className="overflow-hidden">
                          <p className="text-sm font-bold text-slate-900 truncate max-w-[200px]">{extractFile.name}</p>
                          <p className="text-xs text-slate-500">{(extractFile.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                      </div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); setExtractFile(null); }}
                        className="p-2 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"
                      >
                        <X size={18} />
                      </button>
                    </motion.div>
                  )}

                  {activeTab === 'merge' && mergeFiles.length > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar"
                    >
                      {mergeFiles.map((file, i) => (
                        <div key={i} className="p-3 bg-slate-50 rounded-xl flex items-center justify-between border border-slate-100">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-bold text-slate-400 w-4">{i + 1}</span>
                            <div className="w-8 h-8 bg-white rounded flex items-center justify-center text-primary-600 shadow-sm">
                              <FileText size={16} />
                            </div>
                            <p className="text-sm font-medium text-slate-900 truncate max-w-[180px]">{file.name}</p>
                          </div>
                          <button 
                            onClick={(e) => { e.stopPropagation(); removeMergeFile(i); }}
                            className="p-1.5 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Feedback */}
                <AnimatePresence>
                  {error && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-6 p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3 border border-red-100"
                    >
                      <AlertCircle size={20} className="shrink-0 mt-0.5" />
                      <p className="text-sm font-medium">{error}</p>
                    </motion.div>
                  )}
                  {success && !extractedData && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-6 p-4 bg-emerald-50 text-emerald-700 rounded-xl flex items-start gap-3 border border-emerald-100"
                    >
                      <CheckCircle2 size={20} className="shrink-0 mt-0.5" />
                      <p className="text-sm font-medium">{success}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Action Button (Initial) */}
                {!extractedData && (
                  <div className="mt-8">
                    <button
                      disabled={isAnalyzing || isUploading || (activeTab === 'extract' ? !extractFile : mergeFiles.length < 2)}
                      onClick={activeTab === 'extract' ? handleExtract : handleMerge}
                      className={cn(
                        "w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all shadow-lg",
                        (isAnalyzing || isUploading)
                          ? "bg-slate-100 text-slate-400 cursor-not-allowed" 
                          : "bg-primary-600 text-white hover:bg-primary-700 hover:shadow-primary-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none disabled:cursor-not-allowed"
                      )}
                    >
                      {isAnalyzing || isUploading ? (
                        <>
                          <Loader2 size={20} className="animate-spin" />
                          {isAnalyzing ? "Analyzing PDF..." : "Processing..."}
                        </>
                      ) : (
                        <>
                          {activeTab === 'extract' ? (
                            <>Analyze PDF & Preview <ArrowRight size={20} /></>
                          ) : (
                            <>Merge {mergeFiles.length} PDFs <ArrowRight size={20} /></>
                          )}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
              
              {/* Footer Info */}
              <div className="bg-slate-50 px-8 py-4 border-t border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-4 text-xs font-medium text-slate-400">
                  <span className="flex items-center gap-1"><CheckCircle2 size={12} /> Secure Processing</span>
                  <span className="flex items-center gap-1"><CheckCircle2 size={12} /> AI Powered</span>
                </div>
                <div className="text-xs font-bold text-primary-600 flex items-center gap-1">
                  Learn more <ChevronRight size={12} />
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-8 border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-slate-500">
            © 2024 PDF Master. All rights reserved.
          </p>
          <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
            <a href="#" className="hover:text-slate-900">Privacy Policy</a>
            <a href="#" className="hover:text-slate-900">Terms of Service</a>
            <a href="#" className="hover:text-slate-900">Contact</a>
          </div>
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #e2e8f0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #cbd5e1;
        }
      `}</style>
    </div>
  );
}
