import { NextRequest, NextResponse } from 'next/server';

// Use COMPARE_API_BASE for version control (defaults to v2)
const COMPARE_API_BASE = process.env.COMPARE_API_BASE || 'http://localhost:5052';
const FALLBACK_COMPARE_API_BASE = process.env.FALLBACK_COMPARE_API_BASE || null; // Disabled
const REQUEST_TIMEOUT = Number(process.env.COMPARE_REQUEST_TIMEOUT || 90000); // 90 seconds default

async function fetchWithTimeout(url: string, options: RequestInit, timeout: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let targetUrl = COMPARE_API_BASE;
  let isUsingFallback = false;
  
  try {
    const body = await request.json();
    
    // Log which version is being used
    console.log(`[Compare2 API] Using ${targetUrl} (${targetUrl.includes('5052') ? 'v2 FAB-Enhanced' : 'v1'})`);
    
    // Try primary endpoint first
    try {
      const response = await fetchWithTimeout(
        `${targetUrl}/compare2`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        REQUEST_TIMEOUT
      );

      const data = await response.json();
      const duration = Date.now() - startTime;
      
      // Log metrics
      console.log(`[Compare2 API] Response from ${targetUrl} in ${duration}ms, success: ${data.success}`);
      
      // Add metadata about which service responded
      if (data.success) {
        data._proxyMetadata = {
          backend: targetUrl,
          version: targetUrl.includes('5052') ? 'v2' : 'v1',
          durationMs: duration,
        };
      }
      
      return NextResponse.json(data);
      
    } catch (primaryError) {
      // Check if it's a timeout error
      if (primaryError instanceof Error && primaryError.name === 'AbortError') {
        const duration = Date.now() - startTime;
        console.error(`[Compare2 API] Request timeout after ${duration}ms`);
        
        return NextResponse.json(
          { 
            success: false, 
            errorCode: 'TIMEOUT',
            source: 'api-route-timeout',
            message: `Request timed out after ${REQUEST_TIMEOUT}ms`,
            timeoutMs: REQUEST_TIMEOUT,
            _proxyMetadata: {
              backend: targetUrl,
              durationMs: duration,
              timeout: true,
            }
          },
          { status: 504 } // Gateway Timeout
        );
      }
      
      // No fallback configured or other error type
      throw primaryError;
    }
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Compare2 API] All attempts failed after ${duration}ms:`, error);
    
    return NextResponse.json(
      { 
        success: false, 
        errorCode: 'UNKNOWN', 
        message: error instanceof Error ? error.message : 'Proxy error',
        _proxyMetadata: {
          backend: targetUrl,
          durationMs: duration,
          error: true,
        }
      },
      { status: 200 } // Keep 200 for consistency with backend error format
    );
  }
}

export async function GET() {
  return NextResponse.json({ 
    status: 'ok', 
    service: 'compare2-proxy',
    primary: COMPARE_API_BASE,
    fallback: FALLBACK_COMPARE_API_BASE,
    currentVersion: COMPARE_API_BASE.includes('5052') ? 'v2 (FAB-Enhanced)' : 'v1',
  });
}