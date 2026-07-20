// State
let models = [];
let startTime = Date.now();

// DOM Ready
document.addEventListener('DOMContentLoaded', async () => {
    setupMenuToggle();
    setupCodeTabs();
    await loadModels();
    setupUrls();
    updateUptime();
    setTimeout(testConnection, 1000);
});

// Menu Toggle
function setupMenuToggle() {
    const toggle = document.getElementById('menuToggle');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        }
    });
}

// Code Tabs
function setupCodeTabs() {
    const tabs = document.querySelectorAll('.code-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active from all tabs
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Show corresponding code
            const tabName = tab.dataset.tab;
            const blocks = document.querySelectorAll('.code-block');
            blocks.forEach(block => {
                block.classList.remove('active');
                if (block.id === tabName + 'Example') {
                    block.classList.add('active');
                }
            });
        });
    });
}

// Load Models
async function loadModels() {
    try {
        const response = await fetch('/v1/models');
        const data = await response.json();
        
        models = data.data || [];
        const modelsList = document.getElementById('modelsList');
        const modelCount = document.getElementById('modelCount');
        const modelBadge = document.getElementById('modelBadge');
        
        modelCount.textContent = models.length;
        modelBadge.textContent = `${models.length} models`;
        
        modelsList.innerHTML = '';
        
        if (models.length > 0) {
            models.forEach((model, index) => {
                const div = document.createElement('div');
                div.className = 'model-item';
                const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                div.innerHTML = `
                    <span class="model-name">
                        <span class="icon">${letters[index % letters.length]}</span>
                        ${model.id}
                    </span>
                    <span class="model-tag">NVIDIA</span>
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
        document.getElementById('modelBadge').textContent = 'Error';
    }
}

// Setup URLs
function setupUrls() {
    const baseUrl = window.location.origin;
    document.getElementById('baseUrl').querySelector('code').textContent = baseUrl;
    document.getElementById('chatUrl').querySelector('code').textContent = `${baseUrl}/v1/chat/completions`;
    
    // Update hostname in code examples
    const hostname = window.location.hostname;
    document.querySelectorAll('.hostname-placeholder').forEach(el => {
        el.textContent = hostname;
    });
}

// Update Uptime
function updateUptime() {
    const uptime = document.getElementById('uptime');
    setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(elapsed / 3600);
        const minutes = Math.floor((elapsed % 3600) / 60);
        const seconds = elapsed % 60;
        uptime.textContent = hours > 0 
            ? `${hours}h ${minutes}m ${seconds}s`
            : `${minutes}m ${seconds}s`;
    }, 1000);
}

// Test Connection
async function testConnection() {
    const testStatus = document.getElementById('testStatus');
    const icon = testStatus.querySelector('i');
    const message = testStatus.querySelector('span');
    
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
        message.textContent = `❌ Connection failed`;
        showToast('Connection failed', 'error');
    }
}

// Copy to Clipboard
function copyToClipboard(elementId) {
    let textToCopy = '';
    
    if (elementId === 'baseUrl') {
        textToCopy = window.location.origin;
    } else if (elementId === 'chatUrl') {
        textToCopy = `${window.location.origin}/v1/chat/completions`;
    } else {
        const el = document.getElementById(elementId);
        if (el) {
            textToCopy = el.textContent;
        }
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

// Toast Notification
function showToast(message, type = 'success') {
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