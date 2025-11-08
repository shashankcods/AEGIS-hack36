// public/intercept_inject.js
// Injected directly into ChatGPT's page context to intercept hidden uploads
(function() {
  const origFetch = window.fetch;

  // Helper: read a File object as Base64 (async)
  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        // Strip prefix like: "data:image/png;base64,..."
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  window.fetch = async function(resource, config) {
    try {
      if (config && config.body instanceof FormData) {
        const fileEntries = [];
        for (const [key, val] of config.body.entries()) {
          if (val instanceof File) {
            fileEntries.push(val);
          }
        }

        if (fileEntries.length > 0) {
          const metaList = [];
          for (const file of fileEntries) {
            let base64Data = null;
            try {
              // Limit size to 4MB to prevent huge Base64 payloads
              if (file.size <= 4 * 1024 * 1024) {
                base64Data = await fileToBase64(file);
              }
            } catch (e) {
              console.warn('[AEGIS inject] base64 conversion failed for', file.name, e);
            }

            metaList.push({
              name: file.name,
              type: file.type,
              size: file.size,
              base64: base64Data
            });
          }

          // Notify the content script about intercepted uploads
          window.postMessage({
            aegisIntercept: true,
            files: metaList
          }, '*');
        }
      }
    } catch (e) {
      console.warn('[AEGIS inject] interception error', e);
    }

    // Continue with the original fetch request
    return origFetch.apply(this, arguments);
  };

  console.log('[AEGIS inject] fetch interceptor active');
})();
