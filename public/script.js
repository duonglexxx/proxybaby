// Load models and setup on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadModels();
    setupUrls();
});

async function loadModels() {
    try {
        const response = await fetch('/v1/models');
        const data = await response.json();
        
        const modelsList = document.getElementById('modelsList');
        modelsList.innerHTML = '';
        
        if (data.data && data.data.length > 0) {
            data.data.forEach((model, index) => {
                const div = document.createElement('div');
                div.className = 'model-item';
                div.innerHTML = `
                    <span class="model-name">
                        <span class="icon">${String.fromCharCode(65 + index)}</span>
                        ${model.id}
                    </span>
                    <span class="model-tag">NVIDIA NIM</span>
                `;
                modelsList.appendChild(div);
            });
        } else {
            modelsList.innerHTML = '<div class="loading-spinner">No models available</div>';
        }
    } catch (error) {
        console.error('Error loading models:', error);
        document.getElementById('modelsList').innerHTML = `
            <div class="loading-spinner" style="color: #ff6b6b;">
                <i class="fas fa-exclamation-circle"></i>
                Failed to load models
            </div>
        `;
    }
}

function setupUrls() {
    const baseUrl = window.location.origin;
    document.getElementById('baseUrl').textContent = baseUrl;
    document.getElementById('chatUrl').textContent = `${baseUrl}/v1/chat/completions`;
    
    // Update hostname in code examples
    const hostname = window.location.hostname;
    const hostnameElements = document.querySelectorAll('#hostname, #hostname2');
    hostnameElements.forEach(el => {
        el.textContent = hostname;
    });
}

async function testConnection() {
    const testStatus = document.getElementById('testStatus');
    const icon = testStatus.querySelector('i');
    const message = testStatus.querySelector('span');
    
    // Reset
    testStatus.className = 'test-status';
    icon.className = 'fas fa-spinner fa-spin';
    message.textContent = 'Testing connection...';
    
    try {
        const response = await fetch('/health');
        const data = await response.json();
        
        if (response.ok) {
            testStatus.className = 'test-status success';
            icon.className = 'fas fa-check-circle';
            message.textContent = `✅ Connected! ${data.models?.length || 0} models available`;
            showToast('Connection successful!', 'success');
        } else {
            throw new Error('Health check failed');
        }
    } catch (error) {
        testStatus.className = 'test-status error';
        icon.className = 'fas fa-times-circle';
        message.textContent = `❌ Connection failed: ${error.message}`;
        showToast('Connection failed', 'error');
    }
}

function copyToClipboard(elementId) {
    let textToCopy = '';
    
    if (elementId === 'baseUrl') {
        textToCopy = window.location.origin;
    } else if (elementId === 'chatUrl') {
        textToCopy = `${window.location.origin}/v1/chat/completions`;
    } else if (elementId === 'curlExample') {
        const el = document.getElementById('curlExample');
        textToCopy = el.textContent.replace('https://<span id="hostname">your-domain</span>', `https://${window.location.hostname}`);
    } else if (elementId === 'pythonExample') {
        const el = document.getElementById('pythonExample');
        textToCopy = el.textContent.replace('https://<span id="hostname2">your-domain</span>', `https://${window.location.hostname}`);
    } else {
        const el = document.getElementById(elementId);
        if (el) textToCopy = el.textContent;
    }
    
    if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            showToast('Copied to clipboard!', 'success');
        }).catch(() => {
            // Fallback
            const textarea = document.createElement('textarea');
            textarea.value = textToCopy;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            showToast('Copied to clipboard!', 'success');
        });
    }
}

function showToast(message, type = 'success') {
    // Remove existing toasts
    document.querySelectorAll('.toast').forEach(el => el.remove());
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}"></i>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Auto-test connection on load
setTimeout(testConnection, 500);