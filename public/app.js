document.addEventListener('DOMContentLoaded', () => {
    // ==========================================
    // STATE VARIABLES & DYNAMIC WALLPAPER LOAD
    // ==========================================
    let currentUser = null;    // { id_cajero/id_admin, nombre, rol, id_barra, etc }
    let currentWaiter = null;  // { id_mesero, nombre }
    let categories = [];       // List of product categories
    let products = [];         // List of products
    let cart = [];             // Cart items: { id_producto, nombre, precio_venta, cantidad, stock_max }
    let payments = [];         // Payment pills: { id_metodo_pago, nombre_metodo, monto, referencia }
    let activeCategory = 'all';// Filter categories

    // System view elements
    const loginView = document.getElementById('login-view');
    const posView = document.getElementById('pos-view');
    const adminView = document.getElementById('admin-view');
    const waiterModal = document.getElementById('waiter-lock-modal');
    const printModal = document.getElementById('print-modal');
    const voidModal = document.getElementById('void-confirm-modal');

    // Forms
    const loginForm = document.getElementById('login-form');
    const voidForm = document.getElementById('void-order-form');

    // Errors
    const loginError = document.getElementById('login-error');
    const waiterError = document.getElementById('waiter-error');

    // Dynamic wallpaper color extractor
    function loadAndAnalyzeWallpaper() {
        const img = new Image();
        // Try the exact capitalized name from root first
        img.src = 'Wallpaper.jpg';
        
        img.onerror = () => {
            if (img.src.endsWith('Wallpaper.jpg')) {
                img.src = 'wallpaper.jpg'; // fallback lowercase
            }
        };

        img.onload = () => {
            // Set background image dynamically on body
            document.body.style.setProperty('--wallpaper-url', `url('${img.src}')`);
            
            // Extract colors from the wallpaper with exhaustive binning checks
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = 20;
                canvas.height = 20; // 20x20 grid to get a solid representative sample
                ctx.drawImage(img, 0, 0, 20, 20);
                
                const imgData = ctx.getImageData(0, 0, 20, 20).data;
                
                let rSum = 0, gSum = 0, bSum = 0;
                let count = 0;
                const bins = {};
                
                for (let i = 0; i < imgData.length; i += 4) {
                    const r = imgData[i];
                    const g = imgData[i+1];
                    const b = imgData[i+2];
                    
                    const brightness = (r + g + b) / 3;
                    // Exclude pure dark colors to avoid counting shadows/borders
                    if (brightness > 20) {
                        rSum += r;
                        gSum += g;
                        bSum += b;
                        count++;
                        
                        // Round colors to nearest multiple of 16 to group similar shades (quantization)
                        const rBin = Math.round(r / 16) * 16;
                        const gBin = Math.round(g / 16) * 16;
                        const bBin = Math.round(b / 16) * 16;
                        const key = `${rBin},${gBin},${bBin}`;
                        bins[key] = (bins[key] || 0) + 1;
                    }
                }
                
                // If the entire image is dark/black, fall back to all pixels
                if (count === 0) {
                    for (let i = 0; i < imgData.length; i += 4) {
                        const r = imgData[i];
                        const g = imgData[i+1];
                        const b = imgData[i+2];
                        rSum += r;
                        gSum += g;
                        bSum += b;
                        count++;
                        
                        const rBin = Math.round(r / 16) * 16;
                        const gBin = Math.round(g / 16) * 16;
                        const bBin = Math.round(b / 16) * 16;
                        const key = `${rBin},${gBin},${bBin}`;
                        bins[key] = (bins[key] || 0) + 1;
                    }
                }
                
                // Find the dominant color bin (most frequent color)
                let dominantKey = null;
                let maxCount = -1;
                for (const key in bins) {
                    if (bins[key] > maxCount) {
                        maxCount = bins[key];
                        dominantKey = key;
                    }
                }
                
                let rDom, gDom, bDom;
                if (dominantKey) {
                    const parts = dominantKey.split(',').map(Number);
                    rDom = parts[0];
                    gDom = parts[1];
                    bDom = parts[2];
                } else {
                    rDom = Math.round(rSum / count);
                    gDom = Math.round(gSum / count);
                    bDom = Math.round(bSum / count);
                }
                
                // Convert dominant color to HSL
                const hsl = rgbToHsl(rDom, gDom, bDom);
                const hue = Math.round(hsl.h * 360);
                const sat = hsl.s;
                const light = hsl.l;
                
                let primaryColor, accentColor, gradient;
                
                // Check for White/Gray/Light-cream dominant wallpaper
                // If saturation is very low OR lightness is very high (meaning the color is white/light pastel)
                if (sat < 0.20 || light > 0.75) {
                    console.log("⚪ White/Gray theme activated (Dominant color is white/light).");
                    primaryColor = '#ffffff';
                    accentColor = '#f1f5f9'; // clean white/silver
                    gradient = 'linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #64748b 100%)';
                    
                    const root = document.documentElement;
                    root.style.setProperty('--primary', primaryColor);
                    root.style.setProperty('--accent-color', accentColor);
                    root.style.setProperty('--gradient-primary', gradient);
                    root.style.setProperty('--shadow-neon-pink', '0 0 20px rgba(255, 255, 255, 0.35)');
                    root.style.setProperty('--shadow-glow', '0 0 20px rgba(255, 255, 255, 0.2)');
                } else {
                    // Colored theme: map directly to the dominant hue
                    const finalSat = Math.round(Math.max(sat, 0.6) * 100);
                    const finalLight = Math.round(Math.max(Math.min(light, 0.72), 0.45) * 100); // clamp only to guarantee visibility
                    
                    primaryColor = `hsl(${hue}, ${finalSat}%, ${finalLight}%)`;
                    // Accent is a vibrantly shifted analogous/triadic tone
                    const accentHue = (hue + 35) % 360;
                    accentColor = `hsl(${accentHue}, ${finalSat}%, ${finalLight}%)`;
                    
                    gradient = `linear-gradient(135deg, hsl(${hue}, ${finalSat}%, ${Math.min(finalLight + 12, 90)}%) 0%, hsl(${(hue + 20) % 360}, ${finalSat}%, ${finalLight}%) 50%, hsl(${(hue + 40) % 360}, ${finalSat}%, ${Math.max(finalLight - 12, 35)}%) 100%)`;
                    
                    const root = document.documentElement;
                    root.style.setProperty('--primary', primaryColor);
                    root.style.setProperty('--accent-color', accentColor);
                    root.style.setProperty('--gradient-primary', gradient);
                    root.style.setProperty('--shadow-neon-pink', `0 0 20px hsl(${(hue + 20) % 360}, ${finalSat}%, ${finalLight}%, 0.35)`);
                    root.style.setProperty('--shadow-glow', `0 0 20px hsl(${hue}, ${finalSat}%, ${finalLight}%, 0.25)`);
                    
                    console.log(`🎨 Colored Theme Activated. Dominant color matches: hsl(${hue}, ${finalSat}%, ${finalLight}%)`);
                }
            } catch (e) {
                console.error("Failed to analyze wallpaper colors:", e);
            }
        };
    }

    // RGB to HSL helper
    function rgbToHsl(r, g, b) {
        r /= 255, g /= 255, b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s;
        const l = (max + min) / 2;

        if (max === min) {
            h = s = 0; // achromatic
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h, s, l };
    }

    // Initialize wallpaper styling
    loadAndAnalyzeWallpaper();

    // ==========================================
    // 1. ROUTING & LOGIN CONTROLLER
    // ==========================================
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.classList.add('hide');

        const usuario = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usuario, password })
            });
            const data = await response.json();

            if (data.success) {
                currentUser = data.user;
                currentUser.rol = data.rol;

                // Reset forms
                loginForm.reset();

                if (data.rol === 'CAJERO') {
                    // Show waiter security modal
                    showWaiterModal();
                } else if (data.rol === 'ADMINISTRADOR' || data.rol === 'SUPERVISOR') {
                    // Show admin dashboard
                    showAdminView();
                }
            } else {
                showError(loginError, data.message || 'Credenciales incorrectas');
            }
        } catch (err) {
            showError(loginError, 'Error al conectar con el servidor.');
        }
    });

    // PIN pad state and logic
    let waiterPin = '';

    function updatePinDots() {
        const dots = document.querySelectorAll('#pin-dots .dot');
        dots.forEach((dot, idx) => {
            if (idx < waiterPin.length) {
                dot.classList.add('filled');
            } else {
                dot.classList.remove('filled');
            }
        });
    }

    function clearPin() {
        waiterPin = '';
        updatePinDots();
    }

    async function handlePinInput(char) {
        if (waiterPin.length >= 4) return;
        waiterPin += char;
        updatePinDots();
        
        if (waiterPin.length === 4) {
            await verifyWaiterPin(waiterPin);
        }
    }

    function handlePinBackspace() {
        if (waiterPin.length === 0) return;
        waiterPin = waiterPin.slice(0, -1);
        updatePinDots();
    }

    async function verifyWaiterPin(pin) {
        waiterError.classList.add('hide');
        
        try {
            const response = await fetch('/api/login/mesero', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // El PIN se valida contra los meseros asignados a este cajero,
                // no contra todos los del evento.
                body: JSON.stringify({
                    password: pin,
                    id_cajero: currentUser ? currentUser.id_cajero : null,
                    id_evento: currentUser ? currentUser.id_evento : null
                })
            });
            const data = await response.json();

            if (data.success) {
                currentWaiter = data.mesero;
                clearPin();
                waiterModal.classList.add('hide');
                showPOSView();
            } else {
                // Shake visual dots on verification error
                const dotsContainer = document.getElementById('pin-dots');
                dotsContainer.classList.add('shake');
                showError(waiterError, data.message || 'PIN incorrecto');
                
                setTimeout(() => {
                    dotsContainer.classList.remove('shake');
                    clearPin();
                }, 400);
            }
        } catch (err) {
            showError(waiterError, 'Error de conexión.');
            clearPin();
        }
    }

    // Keypad listeners
    document.querySelectorAll('.pin-btn[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-key');
            handlePinInput(key);
        });
    });

    document.getElementById('pin-clear').addEventListener('click', clearPin);
    document.getElementById('pin-back').addEventListener('click', handlePinBackspace);

    // Keyboard bindings for the PIN screen
    window.addEventListener('keydown', (e) => {
        const isWaiterModalActive = !waiterModal.classList.contains('hide') && 
                                    printModal.classList.contains('hide') && 
                                    loginView.classList.contains('hide');
        if (isWaiterModalActive) {
            if (e.key >= '0' && e.key <= '9') {
                handlePinInput(e.key);
            } else if (e.key === 'Backspace') {
                handlePinBackspace();
            } else if (e.key === 'Escape' || e.key === 'Delete') {
                clearPin();
            }
        }
    });

    // Cashier Logout inside Waiter Lock
    document.getElementById('logout-cajero-btn').addEventListener('click', () => {
        currentUser = null;
        clearPin();
        waiterModal.classList.add('hide');
        loginView.classList.remove('hide');
    });

    // Lock POS (Switch waiter)
    document.getElementById('lock-pos-btn').addEventListener('click', () => {
        currentWaiter = null;
        posView.classList.add('hide');
        showWaiterModal();
    });

    // Logout from Admin Panel
    document.getElementById('admin-logout-btn').addEventListener('click', () => {
        currentUser = null;
        adminView.classList.add('hide');
        loginView.classList.remove('hide');
    });

    function showWaiterModal() {
        loginView.classList.add('hide');
        posView.classList.add('hide');
        adminView.classList.add('hide');
        
        document.getElementById('active-cajero-name').textContent = currentUser.nombre;
        clearPin();
        waiterModal.classList.remove('hide');
    }

    // ==========================================
    // 2. POS PORTAL (ORDERING SYSTEM)
    // ==========================================
    async function showPOSView() {
        loginView.classList.add('hide');
        adminView.classList.add('hide');
        posView.classList.remove('hide');

        // Setup headers
        document.getElementById('pos-barra-name').textContent = currentUser.nombre_barra;
        document.getElementById('pos-cajero-label').textContent = currentUser.nombre;
        document.getElementById('pos-mesero-label').textContent = currentWaiter.nombre;

        // Fetch menu
        await fetchProductsAndMenu();
        
        // Reset states
        cart = [];
        payments = [];
        document.getElementById('cart-observations').value = '';
        renderCart();
    }

    async function fetchProductsAndMenu() {
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();
            categories = data.categorias;
            products = data.productos;
            
            renderCategories();
            renderProducts();
        } catch (err) {
            console.error("Error fetching menu:", err);
        }
    }

    function renderCategories() {
        const catList = document.getElementById('category-list');
        catList.innerHTML = '';

        // Add 'All' category
        const allBtn = document.createElement('button');
        allBtn.className = `category-btn ${activeCategory === 'all' ? 'active' : ''}`;
        allBtn.textContent = '🍹 Todos';
        allBtn.addEventListener('click', () => {
            activeCategory = 'all';
            document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
            allBtn.classList.add('active');
            renderProducts();
        });
        catList.appendChild(allBtn);

        // Map icons for types
        const icons = { 'BEBIDA': '🍺', 'COMIDA': '🍔', 'OTRO': '🏷️' };

        categories.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = `category-btn ${activeCategory === cat.id_categoria ? 'active' : ''}`;
            btn.textContent = `${icons[cat.tipo] || '📦'} ${cat.nombre}`;
            btn.addEventListener('click', () => {
                activeCategory = cat.id_categoria;
                document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderProducts();
            });
            catList.appendChild(btn);
        });
    }

    function renderProducts() {
        const grid = document.getElementById('product-grid');
        grid.innerHTML = '';

        const search = document.getElementById('product-search').value.toLowerCase();

        // Filter products based on search and category
        const filtered = products.filter(p => {
            const matchesCat = activeCategory === 'all' || p.id_categoria === activeCategory;
            const matchesSearch = p.nombre.toLowerCase().includes(search) || (p.descripcion && p.descripcion.toLowerCase().includes(search));
            return matchesCat && matchesSearch;
        });

        if (filtered.length === 0) {
            grid.innerHTML = `<div class="empty-cart-msg">No se encontraron productos</div>`;
            return;
        }

        filtered.forEach(p => {
            // Count already in cart to display stock correctly
            const inCart = cart.find(item => item.id_producto === p.id_producto);
            const displayStock = p.stock_actual - (inCart ? inCart.cantidad : 0);

            const card = document.createElement('div');
            card.className = `product-card ${displayStock <= 0 ? 'out-of-stock' : ''}`;
            
            // Emoji mapping based on categories/types
            let emoji = '🍹';
            if (p.tipo_producto === 'BEBIDA_ALCOHOLICA') emoji = '🍺';
            else if (p.tipo_producto === 'BEBIDA_NO_ALCOHOLICA') emoji = '🥤';
            else if (p.tipo_producto === 'COMIDA') emoji = '🍔';

            card.innerHTML = `
                <div>
                    <span class="emoji">${emoji}</span>
                    <h3>${escapeHtml(p.nombre)}</h3>
                </div>
                <div>
                    <div class="price">${p.precio_venta} Bs.</div>
                    <div class="stock ${displayStock < 10 ? 'low' : ''}">Stock: ${displayStock <= 0 ? 'Agotado' : displayStock}</div>
                </div>
                ${displayStock <= 0 ? '<div class="out-of-stock-overlay"><span>Agotado</span></div>' : ''}
            `;

            if (displayStock > 0) {
                card.addEventListener('click', () => {
                    addToCart(p);
                });
            }

            grid.appendChild(card);
        });
    }

    document.getElementById('product-search').addEventListener('input', renderProducts);

    // Cart Lógica
    function addToCart(product) {
        const existing = cart.find(item => item.id_producto === product.id_producto);
        
        if (existing) {
            if (existing.cantidad < product.stock_actual) {
                existing.cantidad++;
            }
        } else {
            cart.push({
                id_producto: product.id_producto,
                nombre: product.nombre,
                precio_venta: parseFloat(product.precio_venta),
                cantidad: 1,
                stock_max: product.stock_actual
            });
        }
        
        renderCart();
        renderProducts(); // Update stock count on cards
    }

    function renderCart() {
        const container = document.getElementById('cart-items');
        container.innerHTML = '';

        if (cart.length === 0) {
            container.innerHTML = `<div class="empty-cart-msg">El carrito está vacío</div>`;
            document.getElementById('cart-total-amount').textContent = '0.00 Bs.';
            updatePaymentDetails(0);
            return;
        }

        let total = 0;

        cart.forEach(item => {
            const sub = item.precio_venta * item.cantidad;
            total += sub;

            const div = document.createElement('div');
            div.className = 'cart-item';
            div.innerHTML = `
                <div class="cart-item-info">
                    <h4>${escapeHtml(item.nombre)}</h4>
                    <div class="price">${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.</div>
                </div>
                <div class="cart-item-controls">
                    <button class="cart-qty-btn decrease-btn">-</button>
                    <span class="qty">${item.cantidad}</span>
                    <button class="cart-qty-btn increase-btn">+</button>
                    <button class="remove-item-btn">🗑️</button>
                </div>
            `;

            // Qty listeners
            div.querySelector('.decrease-btn').addEventListener('click', () => {
                if (item.cantidad > 1) {
                    item.cantidad--;
                } else {
                    cart = cart.filter(c => c.id_producto !== item.id_producto);
                }
                renderCart();
                renderProducts();
            });

            div.querySelector('.increase-btn').addEventListener('click', () => {
                if (item.cantidad < item.stock_max) {
                    item.cantidad++;
                    renderCart();
                    renderProducts();
                }
            });

            div.querySelector('.remove-item-btn').addEventListener('click', () => {
                cart = cart.filter(c => c.id_producto !== item.id_producto);
                renderCart();
                renderProducts();
            });

            container.appendChild(div);
        });

        document.getElementById('cart-total-amount').textContent = `${total.toFixed(2)} Bs.`;
        updatePaymentDetails(total);
    }

    document.getElementById('clear-cart').addEventListener('click', () => {
        cart = [];
        renderCart();
        renderProducts();
    });

    // ==========================================
    // 3. MULTI-PAYMENT CONTROLLER
    // ==========================================
    let orderTotal = 0;

    function updatePaymentDetails(total) {
        orderTotal = total;
        
        // Recalculate remaining
        const paidTotal = payments.reduce((sum, p) => sum + p.monto, 0);
        const remaining = Math.max(0, orderTotal - paidTotal);

        document.getElementById('paid-amount-label').textContent = `${paidTotal.toFixed(2)} Bs.`;
        const remainingLabel = document.getElementById('remaining-amount-label');
        remainingLabel.textContent = `${remaining.toFixed(2)} Bs.`;

        // Style remaining amount
        if (remaining <= 0 && orderTotal > 0) {
            remainingLabel.style.color = '#10b981'; // emerald green
            document.getElementById('finalize-order-btn').disabled = false;
        } else {
            remainingLabel.style.color = '#ef4444'; // red
            document.getElementById('finalize-order-btn').disabled = true;
        }

        renderPayments();
    }

    document.getElementById('add-payment-btn').addEventListener('click', () => {
        const select = document.getElementById('payment-method-select');
        const amountInput = document.getElementById('payment-amount-input');
        
        const id_metodo_pago = parseInt(select.value);
        const nombre_metodo = select.options[select.selectedIndex].text;
        const monto = parseFloat(amountInput.value);

        if (isNaN(monto) || monto <= 0) {
            alert('Por favor introduce un monto de pago válido.');
            return;
        }

        const paidTotal = payments.reduce((sum, p) => sum + p.monto, 0);
        const remaining = orderTotal - paidTotal;

        if (monto > remaining + 0.01) {
            alert('El monto ingresado supera la deuda restante.');
            return;
        }

        // Generate unique reference mock
        const refPrefixes = { 1: 'EFECTIVO-CAJA', 2: 'TARJETA-OP', 3: 'QR-MONEY', 4: 'TRANSF-OP' };
        const refNum = Math.floor(100000 + Math.random() * 900000);
        const referencia = `${refPrefixes[id_metodo_pago] || 'PAGO'}-${refNum}`;

        payments.push({ id_metodo_pago, nombre_metodo, monto, referencia });
        amountInput.value = '';

        updatePaymentDetails(orderTotal);
    });

    function renderPayments() {
        const list = document.getElementById('payments-list');
        list.innerHTML = '';

        payments.forEach((p, idx) => {
            const pill = document.createElement('div');
            pill.className = 'payment-pill';
            pill.innerHTML = `
                <span>${escapeHtml(p.nombre_metodo)}: <strong>${p.monto.toFixed(2)} Bs.</strong></span>
                <button data-idx="${idx}">✕</button>
            `;

            pill.querySelector('button').addEventListener('click', () => {
                payments.splice(idx, 1);
                updatePaymentDetails(orderTotal);
            });

            list.appendChild(pill);
        });
    }

    // FINALIZATION & CHECKOUT SUBMIT
    document.getElementById('finalize-order-btn').addEventListener('click', async () => {
        if (cart.length === 0 || orderTotal <= 0) return;

        const observaciones = document.getElementById('cart-observations').value;

        const bodyData = {
            id_evento: currentUser.id_evento,
            id_barra: currentUser.id_barra,
            id_cajero: currentUser.id_cajero,
            id_mesero: currentWaiter.id_mesero,
            total: orderTotal,
            observaciones,
            items: cart.map(c => ({
                id_producto: c.id_producto,
                cantidad: c.cantidad,
                precio_unitario: c.precio_venta,
                subtotal: c.precio_venta * c.cantidad
            })),
            metodos_pago: payments
        };

        try {
            const response = await fetch('/api/comanda', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData)
            });
            const result = await response.json();

            if (result.success) {
                // El servidor recalcula precios y total desde la base de datos:
                // el ticket se imprime con esos valores, no con los del navegador.
                triggerThermalPrint(result.id_comanda, Object.assign({}, bodyData, {
                    total: typeof result.total === 'number' ? result.total : bodyData.total,
                    items: (result.items && result.items.length) ? result.items : bodyData.items
                }));
            } else {
                alert(result.message || 'Ocurrió un error al guardar la comanda.');
            }
        } catch (err) {
            alert('Error al conectar con la base de datos.');
        }
    });

    // ==========================================
    // 4. VISTA PREVIA E IMPRESIÓN TÉRMICA (RawBT)
    // ==========================================
    // La vista previa se genera con el mismo maquetado que se manda a la
    // impresora (ver rawbt.js), así que lo que se ve es lo que sale impreso.
    let isReprinting = false;
    let currentTicket = null;   // modelo del ticket que se está mostrando

    /**
     * Traduce una venta —recién cerrada o recuperada del historial— al modelo
     * único de ticket que consumen la vista previa y la impresora.
     */
    function buildTicketModel(id_comanda, data) {
        const fecha = data.fecha_hora ? new Date(data.fecha_hora) : new Date();

        return {
            id: id_comanda,
            fecha: fecha.toLocaleString(),
            barra: data.nombre_barra || (currentUser ? currentUser.nombre_barra : 'Barra'),
            cajero: data.nombre_cajero || (currentUser ? currentUser.nombre : 'Cajero'),
            mesero: data.nombre_mesero || (currentWaiter ? currentWaiter.nombre : 'Mesero'),
            total: Number(data.total) || 0,
            observaciones: data.observaciones || 'Sin observaciones',
            items: (data.items || []).map(item => {
                const known = products.find(p => p.id_producto === item.id_producto);
                return {
                    cantidad: item.cantidad,
                    nombre: item.nombre || (known ? known.nombre : 'Producto'),
                    subtotal: Number(item.subtotal) || 0
                };
            }),
            pagos: (data.metodos_pago || payments).map(pay => {
                const metodo = pay.nombre_metodo || pay.nombre || 'Pago';
                // La referencia arranca con el método (EFECTIVO-CAJA-123456).
                const prefijo = pay.referencia ? ' (' + String(pay.referencia).split('-')[0] + ')' : '';
                return { etiqueta: metodo + prefijo, monto: Number(pay.monto) || 0 };
            })
        };
    }

    function renderTicketPreview(model) {
        const settings = ThermalPrinter.getSettings();
        const tickets = ThermalPrinter.buildTickets(model, settings);
        document.getElementById('ticket-cajero-body').innerHTML =
            ThermalPrinter.helpers.opsToHtml(tickets.cajero, settings);
        document.getElementById('ticket-mesero-body').innerHTML =
            ThermalPrinter.helpers.opsToHtml(tickets.mesero, settings);
    }

    function setPrintStatus(text, kind) {
        const box = document.getElementById('print-status');
        if (!text) {
            box.classList.add('hide');
            return;
        }
        box.textContent = text;
        box.className = 'print-status ' + (kind || 'info');
    }

    // Deja constancia de cada impresión física en impresion_comanda_*.
    // Es informativo: si falla, la impresión igual se hizo.
    function logPrint(id_comanda) {
        // El ticket de prueba no corresponde a ninguna comanda: no se registra.
        if (!Number.isInteger(Number(id_comanda))) return;

        ['cajero', 'mesero'].forEach(tipo => {
            fetch('/api/impresion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_comanda, tipo })
            }).catch(err => console.warn('No se pudo registrar la impresión:', err));
        });
    }

    function sendToPrinter() {
        if (!currentTicket) return;
        try {
            ThermalPrinter.printToRawBT(currentTicket);
            logPrint(currentTicket.id);
            setPrintStatus('Enviado a RawBT. Si no imprime nada, revisa ⚙️ Impresora.', 'ok');
        } catch (err) {
            console.error('Error al enviar a RawBT:', err);
            setPrintStatus('No se pudo abrir RawBT. ¿Está instalado en la tablet?', 'error');
        }
    }

    function triggerThermalPrint(id_comanda, data, fromAdmin = false) {
        isReprinting = fromAdmin;
        currentTicket = buildTicketModel(id_comanda, data);

        renderTicketPreview(currentTicket);
        setPrintStatus('');
        document.getElementById('printer-settings').classList.add('hide');
        printModal.classList.remove('hide');

        if (ThermalPrinter.getSettings().autoPrint) {
            sendToPrinter();
        }
    }

    document.getElementById('print-rawbt-btn').addEventListener('click', sendToPrinter);

    document.getElementById('print-browser-btn').addEventListener('click', () => {
        if (!currentTicket) return;
        ThermalPrinter.printViaBrowser(currentTicket);
        logPrint(currentTicket.id);
    });

    // ---- Panel de configuración de impresora ----
    const printerSettingsPanel = document.getElementById('printer-settings');

    const settingsFields = {
        'cfg-width':    { key: 'width',     parse: v => parseInt(v, 10) },
        'cfg-encoding': { key: 'encoding',  parse: v => v },
        'cfg-mode':     { key: 'mode',      parse: v => v },
        'cfg-single':   { key: 'singleJob', parse: v => v === '1' },
        'cfg-cut':      { key: 'cut',       parse: v => v === '1' },
        'cfg-auto':     { key: 'autoPrint', parse: v => v === '1' }
    };

    function loadPrinterSettingsIntoForm() {
        const settings = ThermalPrinter.getSettings();
        Object.keys(settingsFields).forEach(id => {
            const value = settings[settingsFields[id].key];
            document.getElementById(id).value = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
        });
    }

    Object.keys(settingsFields).forEach(id => {
        document.getElementById(id).addEventListener('change', e => {
            const field = settingsFields[id];
            ThermalPrinter.saveSettings({ [field.key]: field.parse(e.target.value) });
            // El ancho y los acentos cambian el maquetado: refrescar la vista previa.
            if (currentTicket) renderTicketPreview(currentTicket);
        });
    });

    document.getElementById('printer-settings-btn').addEventListener('click', () => {
        loadPrinterSettingsIntoForm();
        printerSettingsPanel.classList.toggle('hide');
    });

    // Prueba de impresora desde la barra superior del POS: permite dejar la
    // impresora configurada antes de la primera venta del evento.
    document.getElementById('printer-test-btn').addEventListener('click', () => {
        isReprinting = true; // no toca el carrito ni cierra la sesión del mesero
        currentTicket = {
            id: 'PRUEBA',
            fecha: new Date().toLocaleString(),
            barra: currentUser ? currentUser.nombre_barra : 'Barra',
            cajero: currentUser ? currentUser.nombre : 'Cajero',
            mesero: currentWaiter ? currentWaiter.nombre : 'Mesero',
            total: 60,
            observaciones: 'Ticket de prueba de impresora',
            items: [
                { cantidad: 2, nombre: 'Cerveza Paceña 350 ml', subtotal: 36 },
                { cantidad: 1, nombre: 'Hamburguesa clásica', subtotal: 24 }
            ],
            pagos: [{ etiqueta: 'Efectivo (PRUEBA)', monto: 60 }]
        };

        renderTicketPreview(currentTicket);
        setPrintStatus('Ticket de prueba: no se guarda ninguna venta.', 'info');
        loadPrinterSettingsIntoForm();
        printerSettingsPanel.classList.remove('hide');
        printModal.classList.remove('hide');
    });

    loadPrinterSettingsIntoForm();

    // Cerrar la vista previa, limpiar el POS y volver al bloqueo de mesero
    document.getElementById('dismiss-print-btn').addEventListener('click', () => {
        printModal.classList.add('hide');
        currentTicket = null;

        if (isReprinting) {
            isReprinting = false;
            // Reimpresión desde el panel admin: no se toca el estado del POS.
        } else {
            currentWaiter = null;

            // Reset states
            cart = [];
            payments = [];
            document.getElementById('cart-observations').value = '';

            posView.classList.add('hide');
            showWaiterModal();
        }
    });

    // ==========================================
    // 5. ADMINISTRATOR PANEL CONTROLLER
    // ==========================================
    function showAdminView() {
        loginView.classList.add('hide');
        posView.classList.add('hide');
        adminView.classList.remove('hide');

        document.getElementById('admin-role-badge').textContent = currentUser.rol;
        document.getElementById('admin-user-name').textContent = currentUser.nombre;

        // Reset and show default Dashboard Tab
        document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector('[data-tab="tab-dashboard"]').classList.add('active');
        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hide'));
        document.getElementById('tab-dashboard').classList.remove('hide');

        loadDashboardData();
    }

    // Setup Admin Navigation Tab listeners
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const targetTab = btn.getAttribute('data-tab');
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hide'));
            document.getElementById(targetTab).classList.remove('hide');

            // Load data according to tab
            if (targetTab === 'tab-dashboard') loadDashboardData();
            else if (targetTab === 'tab-comandas') loadComandasData();
            else if (targetTab === 'tab-crear-producto') loadCatalogSetup();
            else if (targetTab === 'tab-crear-personal') loadPersonalSetup();
            else if (targetTab === 'tab-stock') loadStockSetup();
            else if (targetTab === 'tab-inventario') loadInventoryData();
            else if (targetTab === 'tab-auditoria') loadAuditsData();
        });
    });

    // TAB: DASHBOARD DATA
    async function loadDashboardData() {
        try {
            const response = await fetch('/api/admin/comandas');
            const comandas = await response.json();
            
            const activeComandas = comandas.filter(c => c.estado_pago !== 'ANULADO');
            const voidedComandas = comandas.filter(c => c.estado_pago === 'ANULADO');

            const totalRecaudado = activeComandas.reduce((sum, c) => sum + parseFloat(c.total), 0);

            document.getElementById('kpi-total-sales').textContent = `${totalRecaudado.toFixed(2)} Bs.`;
            document.getElementById('kpi-total-orders').textContent = comandas.length;
            document.getElementById('kpi-voided-orders').textContent = voidedComandas.length;

            // Group sales by bar for progress list
            const salesByBar = {};
            activeComandas.forEach(c => {
                salesByBar[c.nombre_barra] = (salesByBar[c.nombre_barra] || 0) + parseFloat(c.total);
            });

            const chartContainer = document.getElementById('barras-sales-chart');
            chartContainer.innerHTML = '';

            const barNames = Object.keys(salesByBar);
            if (barNames.length === 0) {
                chartContainer.innerHTML = '<div class="empty-cart-msg">Sin datos de venta todavía</div>';
                return;
            }

            barNames.forEach(name => {
                const amount = salesByBar[name];
                const pct = totalRecaudado > 0 ? (amount / totalRecaudado) * 100 : 0;

                const div = document.createElement('div');
                div.className = 'sales-bar-item';
                div.innerHTML = `
                    <div class="sales-bar-info">
                        <span>${escapeHtml(name)}</span>
                        <strong>${amount.toFixed(2)} Bs. (${pct.toFixed(1)}%)</strong>
                    </div>
                    <div class="sales-bar-track">
                        <div class="sales-bar-fill" style="width: ${pct}%"></div>
                    </div>
                `;
                chartContainer.appendChild(div);
            });
        } catch (err) {
            console.error("Error loading dashboard data:", err);
        }
    }

    // TAB: COMANDAS / VOID LIST
    async function loadComandasData() {
        try {
            const response = await fetch('/api/admin/comandas');
            const comandas = await response.json();

            const container = document.getElementById('comandas-cards-container');
            container.innerHTML = '';

            if (comandas.length === 0) {
                container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); width: 100%; grid-column: 1/-1; padding: 40px;">No hay comandas registradas</div>`;
                return;
            }

            comandas.forEach(c => {
                const detailsHtml = c.detalles.map(d => `<li><span class="qty">${d.cantidad}</span> x ${escapeHtml(d.nombre_producto)}</li>`).join('');
                const paymentsHtml = c.pagos.map(p => `<li>${escapeHtml(p.nombre_metodo)}: ${parseFloat(p.monto).toFixed(2)} Bs.</li>`).join('');
                const badgeClass = c.estado_pago === 'PAGADO' ? 'badge-pagado' : c.estado_pago === 'PENDIENTE' ? 'badge-pendiente' : 'badge-anulado';

                const card = document.createElement('div');
                card.className = 'comanda-mini-card';
                // Save attributes for local real-time search filtering
                card.setAttribute('data-id', c.id_comanda.toString());
                card.setAttribute('data-waiter', c.nombre_mesero);

                card.innerHTML = `
                    <div>
                        <div class="comanda-card-header">
                            <span class="comanda-card-id">Comanda #${c.id_comanda}</span>
                            <span class="badge ${badgeClass}">${c.estado_pago}</span>
                        </div>
                        <div class="comanda-card-meta">
                            <div><strong>Fecha:</strong> ${new Date(c.fecha_hora).toLocaleString()}</div>
                            <div><strong>Barra:</strong> ${escapeHtml(c.nombre_barra)}</div>
                            <div><strong>Cajero:</strong> ${escapeHtml(c.nombre_cajero)}</div>
                            <div><strong>Mesero:</strong> ${escapeHtml(c.nombre_mesero)}</div>
                        </div>
                        <div class="comanda-card-items">
                            <strong>Detalles:</strong>
                            <ul style="margin-top: 6px;">
                                ${detailsHtml}
                            </ul>
                        </div>
                        <div class="comanda-card-payments">
                            <strong>Pagos:</strong>
                            <ul style="margin-top: 4px;">
                                ${paymentsHtml}
                            </ul>
                            ${c.estado_pago === 'ANULADO' ? `<div style="color: var(--danger); font-size: 0.75rem; margin-top: 8px; font-weight: bold;">Motivo: ${escapeHtml(c.motivo_anulacion)}</div>` : ''}
                            ${c.observaciones ? `<div style="color: var(--text-secondary); font-size: 0.75rem; margin-top: 6px; font-style: italic;">Obs: ${escapeHtml(c.observaciones)}</div>` : ''}
                        </div>
                    </div>
                    <div class="comanda-card-footer">
                        <span class="comanda-card-total">${parseFloat(c.total).toFixed(2)} Bs.</span>
                        <div class="comanda-card-actions">
                            <button class="secondary-btn print-card-btn" style="padding: 6px 12px; font-size: 0.8rem;">🖨️ Reimprimir</button>
                            ${c.estado_pago !== 'ANULADO' ? `<button class="danger-btn void-card-btn" style="padding: 6px 12px; font-size: 0.8rem;">Anular</button>` : ''}
                        </div>
                    </div>
                `;

                // Add button click listeners
                if (c.estado_pago !== 'ANULADO') {
                    card.querySelector('.void-card-btn').addEventListener('click', () => {
                        openVoidModal(c.id_comanda);
                    });
                }

                card.querySelector('.print-card-btn').addEventListener('click', () => {
                    const reprintData = {
                        total: parseFloat(c.total),
                        observaciones: c.observaciones,
                        nombre_cajero: c.nombre_cajero,
                        nombre_mesero: c.nombre_mesero,
                        nombre_barra: c.nombre_barra,
                        fecha_hora: c.fecha_hora,
                        items: c.detalles.map(d => ({
                            id_producto: d.id_producto,
                            nombre: d.nombre_producto,
                            cantidad: d.cantidad,
                            subtotal: parseFloat(d.subtotal)
                        })),
                        metodos_pago: c.pagos.map(p => ({
                            nombre_metodo: p.nombre_metodo,
                            referencia: p.referencia || '',
                            monto: parseFloat(p.monto)
                        }))
                    };
                    triggerThermalPrint(c.id_comanda, reprintData, true);
                });

                container.appendChild(card);
            });

            // Trigger search filter refresh if input has content
            const searchInput = document.getElementById('comanda-search-input');
            if (searchInput && searchInput.value) {
                searchInput.dispatchEvent(new Event('input'));
            }
        } catch (err) {
            console.error("Error loading comandas:", err);
        }
    }

    // Real-time local search filter for comandas (restricted to Comanda ID or Waiter Name)
    document.getElementById('comanda-search-input').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const cards = document.querySelectorAll('.comanda-mini-card');

        cards.forEach(card => {
            const id = card.getAttribute('data-id').toLowerCase();
            const waiter = card.getAttribute('data-waiter').toLowerCase();

            const idMatch = id.includes(query) || id.replace('#', '').includes(query);
            const waiterMatch = waiter.includes(query);

            if (idMatch || waiterMatch) {
                card.classList.remove('hide');
            } else {
                card.classList.add('hide');
            }
        });
    });

    // Global reference for onclick void
    window.openVoidModal = function(id_comanda) {
        document.getElementById('void-order-id-label').textContent = `#${id_comanda}`;
        document.getElementById('void-order-id-input').value = id_comanda;
        document.getElementById('void-reason').value = '';
        voidModal.classList.remove('hide');
    };

    // Close void confirmation modal
    document.getElementById('cancel-void-btn').addEventListener('click', () => {
        voidModal.classList.add('hide');
    });

    // Submit void order form
    voidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_comanda = document.getElementById('void-order-id-input').value;
        const motivo_anulacion = document.getElementById('void-reason').value;

        try {
            const response = await fetch('/api/admin/comandas/anular', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_comanda, id_admin: currentUser.id_admin, motivo_anulacion })
            });
            const data = await response.json();

            if (data.success) {
                voidModal.classList.add('hide');
                loadComandasData(); // Refresh list
            } else {
                alert('Error al anular: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // TAB: CATALOG SETUP (CREATE CATEGORY / PRODUCT)
    async function loadCatalogSetup() {
        try {
            // Fetch categories for product form selector
            const response = await fetch('/api/productos');
            const data = await response.json();

            const select = document.getElementById('prod-cat');
            select.innerHTML = '<option value="" disabled selected>Seleccione categoría...</option>';
            data.categorias.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id_categoria;
                opt.textContent = c.nombre;
                select.appendChild(opt);
            });
        } catch (err) {
            console.error(err);
        }
    }

    // Form: Create Category
    document.getElementById('form-create-category').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('cat-name').value;
        const descripcion = document.getElementById('cat-desc').value;
        const tipo = document.getElementById('cat-type').value;

        try {
            const response = await fetch('/api/admin/categorias', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, descripcion, tipo, id_admin: currentUser.id_admin, id_evento: currentUser.id_evento })
            });
            const data = await response.json();

            if (data.success) {
                alert('Categoría creada exitosamente.');
                document.getElementById('form-create-category').reset();
                loadCatalogSetup(); // Refresh product selector
            } else {
                alert('Error: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // Form: Create Product
    document.getElementById('form-create-product').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_categoria = document.getElementById('prod-cat').value;
        const nombre = document.getElementById('prod-name').value;
        const descripcion = document.getElementById('prod-desc').value;
        const tipo_producto = document.getElementById('prod-type').value;
        const precio_venta = document.getElementById('prod-price').value;
        const stock_actual = document.getElementById('prod-stock').value;

        try {
            const response = await fetch('/api/admin/productos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual,
                    id_admin: currentUser.id_admin, id_evento: currentUser.id_evento
                })
            });
            const data = await response.json();

            if (data.success) {
                alert('Producto creado exitosamente.');
                document.getElementById('form-create-product').reset();
            } else {
                alert('Error: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // TAB: PERSONAL & BARRAS SETUP
    async function loadPersonalSetup() {
        try {
            const response = await fetch('/api/admin/configuracion');
            const data = await response.json();

            // Populate Cajero's Barra selector
            const cajBarra = document.getElementById('caj-barra');
            cajBarra.innerHTML = '<option value="" disabled selected>Seleccione barra...</option>';
            data.barras.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id_barra;
                opt.textContent = `${b.nombre_barra} (${b.ubicacion})`;
                cajBarra.appendChild(opt);
            });

            // Populate Mesero's Cajero selector
            const mesCajero = document.getElementById('mes-cajero');
            mesCajero.innerHTML = '<option value="" disabled selected>Seleccione cajero...</option>';
            data.cajeros.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id_cajero;
                opt.textContent = `${c.nombre} (${c.usuario})`;
                mesCajero.appendChild(opt);
            });
        } catch (err) {
            console.error(err);
        }
    }

    // Form: Create Barra
    document.getElementById('form-create-barra').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre_barra = document.getElementById('bar-name').value;
        const descripcion = document.getElementById('bar-desc').value;
        const ubicacion = document.getElementById('bar-location').value;

        try {
            const response = await fetch('/api/admin/barras', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre_barra, descripcion, ubicacion, id_evento: currentUser.id_evento, id_admin: currentUser.id_admin })
            });
            const data = await response.json();

            if (data.success) {
                alert('Barra creada exitosamente.');
                document.getElementById('form-create-barra').reset();
                loadPersonalSetup(); // Refresh selectors
            } else {
                alert('Error: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // Form: Create Cajero
    document.getElementById('form-create-cajero').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_barra = document.getElementById('caj-barra').value;
        const nombre = document.getElementById('caj-name').value;
        const usuario = document.getElementById('caj-user').value;
        const password = document.getElementById('caj-pass').value;

        try {
            const response = await fetch('/api/admin/cajeros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_barra, nombre, usuario, password, id_admin: currentUser.id_admin, id_evento: currentUser.id_evento })
            });
            const data = await response.json();

            if (data.success) {
                alert('Cajero registrado exitosamente.');
                document.getElementById('form-create-cajero').reset();
                loadPersonalSetup();
            } else {
                alert('Error: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // Form: Create Mesero
    document.getElementById('form-create-mesero').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_cajero = document.getElementById('mes-cajero').value;
        const nombre = document.getElementById('mes-name').value;
        const usuario = document.getElementById('mes-user').value;
        const password = document.getElementById('mes-pass').value;

        try {
            const response = await fetch('/api/admin/meseros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_cajero, nombre, usuario, password, id_admin: currentUser.id_admin, id_evento: currentUser.id_evento })
            });
            const data = await response.json();

            if (data.success) {
                alert('Mesero registrado exitosamente.');
                document.getElementById('form-create-mesero').reset();
            } else {
                alert('Error: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // TAB: ADJUST STOCK SETUP
    async function loadStockSetup() {
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();

            const select = document.getElementById('stock-product');
            select.innerHTML = '<option value="" disabled selected>Seleccione producto...</option>';
            data.productos.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id_producto;
                opt.textContent = `${p.nombre} (Stock actual: ${p.stock_actual})`;
                select.appendChild(opt);
            });
        } catch (err) {
            console.error(err);
        }
    }

    // Form: Adjust Stock
    document.getElementById('form-adjust-stock').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id_producto = document.getElementById('stock-product').value;
        const tipo_movimiento = document.getElementById('stock-type').value;
        const cantidad = document.getElementById('stock-qty').value;
        const motivo = document.getElementById('stock-reason').value;

        try {
            const response = await fetch('/api/admin/stock/movimiento', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_producto, tipo_movimiento, cantidad, motivo, id_admin: currentUser.id_admin, id_evento: currentUser.id_evento })
            });
            const data = await response.json();

            if (data.success) {
                alert('Ajuste de stock guardado. Nuevo stock: ' + data.stock_nuevo);
                document.getElementById('form-adjust-stock').reset();
                loadStockSetup(); // Refresh view
            } else {
                alert('Error: ' + data.message);
            }
        } catch (err) {
            alert('Error de conexión.');
        }
    });

    // TAB: AUDIT LOGS DATA
    async function loadAuditsData() {
        try {
            const response = await fetch('/api/admin/auditoria');
            const data = await response.json();

            // Render Stock movements
            const tbodyMovs = document.getElementById('movs-table-body');
            tbodyMovs.innerHTML = '';

            if (data.movimientos.length === 0) {
                tbodyMovs.innerHTML = `<tr><td colspan="7" style="text-align: center;">No hay movimientos de stock</td></tr>`;
            } else {
                data.movimientos.forEach(m => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${escapeHtml(m.nombre_producto)}</strong></td>
                        <td><span class="badge ${m.tipo_movimiento === 'ENTRADA' ? 'badge-entregada' : m.tipo_movimiento === 'SALIDA' ? 'badge-anulado' : 'badge-pendiente'}">${m.tipo_movimiento}</span></td>
                        <td>${m.cantidad}</td>
                        <td>${m.stock_anterior}</td>
                        <td style="font-weight: bold; color: #34d399;">${m.stock_nuevo}</td>
                        <td style="font-size: 0.75rem;">${new Date(m.fecha_hora).toLocaleString()}</td>
                        <td style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(m.motivo || '-')}</td>
                    `;
                    tbodyMovs.appendChild(tr);
                });
            }

            // Render Admin Audits
            const tbodyAudits = document.getElementById('audits-table-body');
            tbodyAudits.innerHTML = '';

            if (data.auditoria.length === 0) {
                tbodyAudits.innerHTML = `<tr><td colspan="4" style="text-align: center;">No hay registros de auditoría</td></tr>`;
            } else {
                data.auditoria.forEach(a => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><strong>${escapeHtml(a.nombre_admin)}</strong></td>
                        <td><span class="badge badge-proceso">${escapeHtml(a.accion)}</span></td>
                        <td style="font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(a.detalle)}</td>
                        <td style="font-size: 0.75rem;">${new Date(a.fecha_hora).toLocaleString()}</td>
                    `;
                    tbodyAudits.appendChild(tr);
                });
            }
        } catch (err) {
            console.error("Error loading audits:", err);
        }
    }

    // TAB: INVENTARIO / STOCK REPORT
    let inventoryPage = 1;
    const inventoryLimit = 10;
    let allInventoryProducts = [];
    let allInventoryCategoriesMap = {};

    async function loadInventoryData() {
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();

            allInventoryProducts = data.productos || [];
            allInventoryCategoriesMap = {};
            
            if (data.categorias) {
                data.categorias.forEach(cat => {
                    allInventoryCategoriesMap[cat.id_categoria] = cat.nombre; // Fixed to show actual category name
                });
            }

            inventoryPage = 1; // reset to page 1 on tab click
            renderInventoryPage();
        } catch (err) {
            console.error("Error loading inventory:", err);
        }
    }

    function renderInventoryPage() {
        const tbody = document.getElementById('inventory-table-body');
        tbody.innerHTML = '';

        if (allInventoryProducts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No hay productos registrados</td></tr>';
            document.getElementById('inventory-page-info').textContent = 'Mostrando página 0 de 0';
            document.getElementById('inventory-prev-btn').disabled = true;
            document.getElementById('inventory-next-btn').disabled = true;
            return;
        }

        const totalPages = Math.ceil(allInventoryProducts.length / inventoryLimit);
        if (inventoryPage > totalPages) inventoryPage = totalPages;
        if (inventoryPage < 1) inventoryPage = 1;

        const start = (inventoryPage - 1) * inventoryLimit;
        const end = start + inventoryLimit;
        const pageProducts = allInventoryProducts.slice(start, end);

        pageProducts.forEach(p => {
            const catName = allInventoryCategoriesMap[p.id_categoria] || 'General';
            const isLow = p.stock_actual <= 15; // Warn if stock is 15 or less
            const stockStyle = isLow ? 'color: var(--danger); font-weight: 700;' : 'font-weight: 700;';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>#${p.id_producto}</td>
                <td>${escapeHtml(catName)}</td>
                <td style="font-weight: 600;">${escapeHtml(p.nombre)}</td>
                <td style="${stockStyle}">${p.stock_actual} ${isLow ? '⚠️ (Bajo)' : ''}</td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('inventory-page-info').textContent = `Mostrando página ${inventoryPage} de ${totalPages} (Total: ${allInventoryProducts.length} productos)`;
        
        // Enable/Disable pagination buttons
        document.getElementById('inventory-prev-btn').disabled = (inventoryPage === 1);
        document.getElementById('inventory-next-btn').disabled = (inventoryPage === totalPages);
    }

    // Bind Pagination listeners
    document.getElementById('inventory-prev-btn').addEventListener('click', () => {
        if (inventoryPage > 1) {
            inventoryPage--;
            renderInventoryPage();
        }
    });

    document.getElementById('inventory-next-btn').addEventListener('click', () => {
        const totalPages = Math.ceil(allInventoryProducts.length / inventoryLimit);
        if (inventoryPage < totalPages) {
            inventoryPage++;
            renderInventoryPage();
        }
    });

    // Reporte de inventario en papel térmico, con el mismo maquetado en columnas
    // fijas que los tickets de venta (ver rawbt.js).
    function buildInventoryOps(settings) {
        const H = ThermalPrinter.helpers;
        const w = settings.width;
        const ops = [];

        ops.push(H.op('*** MASTERDRINKS ***', { align: 'center', bold: true, tall: true }));
        ops.push(H.op('REPORTE DE INVENTARIO', { align: 'center', bold: true }));
        ops.push(H.op(new Date().toLocaleString(), { align: 'center' }));
        ops.push(H.op(H.divider(w)));

        // Agrupado por categoría: en 32 columnas se lee mucho mejor que una
        // tabla de cuatro columnas apretadas.
        const porCategoria = new Map();
        allInventoryProducts.forEach(p => {
            const cat = allInventoryCategoriesMap[p.id_categoria] || 'General';
            if (!porCategoria.has(cat)) porCategoria.set(cat, []);
            porCategoria.get(cat).push(p);
        });

        let bajos = 0;
        [...porCategoria.keys()].sort().forEach(cat => {
            ops.push(H.op(cat.toUpperCase(), { bold: true }));
            porCategoria.get(cat).forEach(p => {
                const isLow = p.stock_actual <= 15;
                if (isLow) bajos++;
                H.twoCol('#' + p.id_producto + ' ' + p.nombre, p.stock_actual + (isLow ? ' *' : ''), w)
                    .forEach(l => ops.push(H.op(l)));
            });
            ops.push(H.op(H.divider(w)));
        });

        ops.push(H.op('Total de productos: ' + allInventoryProducts.length));
        ops.push(H.op('Con stock bajo (<= 15): ' + bajos));
        ops.push(H.op(''));
        ops.push(H.op('* Indica stock bajo', { align: 'center' }));
        ops.push(H.op('Reporte oficial de operacion', { align: 'center' }));

        return ops;
    }

    document.getElementById('print-inventory-btn').addEventListener('click', () => {
        if (allInventoryProducts.length === 0) return;
        const settings = ThermalPrinter.getSettings();
        const H = ThermalPrinter.helpers;
        H.sendBytes(H.opsToEscPos(buildInventoryOps(settings), settings), settings);
    });

    document.getElementById('print-inventory-browser-btn').addEventListener('click', () => {
        if (allInventoryProducts.length === 0) return;
        const settings = ThermalPrinter.getSettings();
        const H = ThermalPrinter.helpers;
        const mm = settings.width >= 48 ? '72mm' : '48mm';

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes.');
            return;
        }

        printWindow.document.write(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Inventario POS</title><style>' +
            '@page { size: auto; margin: 0; }' +
            'body { margin: 0; padding: 4mm; background: #fff; color: #000;' +
            ' font-family: "Courier New", monospace; font-size: 12px; line-height: 1.25; width: ' + mm + '; }' +
            '</style></head><body>' +
            H.opsToHtml(buildInventoryOps(settings), settings) +
            '<script>window.onload=function(){window.print();setTimeout(function(){window.close();},300);};<\/script>' +
            '</body></html>'
        );
        printWindow.document.close();
    });

    // Nombres de producto, motivos de anulación y observaciones los escribe
    // el personal y se insertan con innerHTML: hay que neutralizarlos antes.
    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Utility: helper to show errors inside containers
    function showError(element, text) {
        element.textContent = text;
        element.classList.remove('hide');
    }
});
