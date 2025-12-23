// ======== Retry Logic with Exponential Backoff ========
// Retry up to 3 times with delays: 2s → 4s → 8s

export async function retryWithBackoff(fn, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        console.warn(
          `⚠️  API request failed (attempt ${attempt + 1}/${maxRetries}). ` +
          `Retrying in ${delay / 1000}s... Error: ${error.message}`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  console.error(`❌ API request failed after ${maxRetries} attempts:`, lastError.message);
  throw lastError;
}

// Wrap axios response handling
export function wrapAPIClient(client) {
  client.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status >= 500) {
        console.error('🔴 Server error:', error.response.status);
      }
      throw error;
    }
  );
  return client;
}
