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

    // ==========================================
    // IDENTIDAD DE LA BARRA
    // ==========================================
    // La tablet pregunta al arrancar cómo se llama la barra, para rotularla en
    // pantalla y numerar las comandas con su prefijo (B1-47). El nombre lo pone
    // el encargado en el panel y suele cambiar de un evento a otro.
    let instancia = { nombre: '', prefijo: '' };

    const refComanda = id => (instancia.prefijo ? instancia.prefijo + '-' + id : '#' + id);

    async function cargarInstancia() {
        try {
            const res = await fetch('/api/instancia');
            if (!res.ok) return;
            instancia = await res.json();

            document.querySelectorAll('.instancia-badge').forEach(el => {
                el.textContent = instancia.nombre;
                el.classList.remove('hide');
            });

            // El título nombra el acceso directo cuando se hace "Añadir a
            // pantalla de inicio", y de paso rotula la pestaña del navegador
            // con la barra y el evento que se están atendiendo.
            document.title = 'MasterDrinks · ' + instancia.nombre;
        } catch (err) {
            // Sin identidad la caja sigue funcionando: se cae al '#47' de antes.
            console.warn('No se pudo leer la identidad de la instancia:', err);
        }
    }

    cargarInstancia();
    cargarConfiguracion();

    // ==========================================
    // AVISOS FLOTANTES
    // ==========================================
    // Reemplazan a alert(): en la tablet aquél abre un diálogo del sistema que
    // hay que cerrar a mano, y con la barra llena eso cuesta ventas. Estos se
    // apilan arriba a la derecha y se van solos; los de error aguantan más
    // tiempo porque suelen exigir que el cajero haga algo.
    const TOAST_ICONOS = { ok: '✓', error: '✕', warn: '!', info: 'i' };

    function notify(mensaje, tipo = 'info', ms) {
        const pila = document.getElementById('toast-stack');
        if (!pila) return;

        const toast = document.createElement('div');
        toast.className = 'toast toast-' + tipo;
        toast.innerHTML =
            '<span class="toast-icon">' + (TOAST_ICONOS[tipo] || 'i') + '</span>' +
            '<span class="toast-text"></span>';
        toast.querySelector('.toast-text').textContent = mensaje;

        // Al tocarlo se va: si se apilan varios, el cajero puede despejarlos.
        toast.addEventListener('click', () => cerrarToast(toast));
        pila.appendChild(toast);

        setTimeout(() => cerrarToast(toast), ms || (tipo === 'error' ? 6000 : 3200));
    }

    function cerrarToast(toast) {
        if (!toast.isConnected || toast.classList.contains('toast-out')) return;
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 220);
    }

    // Dynamic wallpaper color extractor
    /**
     * Carga el fondo de pantalla. Nada más.
     *
     * Antes esto analizaba el color dominante de la imagen y reescribía la
     * paleta entera (--primary, --gradient-primary, las sombras). Con un
     * fondo oscuro y poco saturado —como el que hay— caía en la rama
     * "blanco/gris" y dejaba el degradado principal en blanco → gris: los
     * botones de "Iniciar Sesión" y "CONFIRMAR PAGO" salían blancos sobre
     * blanco, con pinta de estar desactivados, y el total del cobro casi no se
     * leía. La identidad de la marca la define el CSS, no la foto del fondo.
     */
    function cargarFondo() {
        const img = new Image();
        img.src = 'Wallpaper.jpg';
        img.onerror = () => {
            if (img.src.endsWith('Wallpaper.jpg')) img.src = 'wallpaper.jpg';
        };
        img.onload = () => {
            document.body.style.setProperty('--wallpaper-url', `url('${img.src}')`);
            document.body.classList.add('con-fondo');
        };
    }

    // Initialize wallpaper styling
    cargarFondo();

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
                // El PIN se valida contra los meseros de esta barra, no contra los
                // de todo el evento: todas las tablets conectadas son de la misma barra.
                body: JSON.stringify({
                    password: pin,
                    id_cajero: currentUser ? currentUser.id_cajero : null,
                    id_barra: currentUser ? currentUser.id_barra : null,
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
        // Caja bloqueada: nadie está vendiendo, no hace falta vigilar el stock.
        detenerSondeoStock();
        
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
        efectivoRecibido = 0;
        document.getElementById('cart-observations').value = '';
        renderCart();

        // Mientras haya caja abierta, las existencias se vigilan solas.
        iniciarSondeoStock();
    }

    async function fetchProductsAndMenu() {
        renderSkeleton();
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();
            categories = data.categorias;
            products = data.productos;

            renderCategories();
            animarRejilla = true;   // única vez que la rejilla entra en cascada
            renderProducts();
        } catch (err) {
            console.error("Error fetching menu:", err);
            notify('No se pudo cargar el catálogo. Revisa la conexión.', 'error');
        }
    }

    // ==========================================
    // STOCK COMPARTIDO ENTRE TABLETS
    // ==========================================
    // Varias tablets venden contra el mismo servidor, así que las existencias
    // cambian por debajo de esta pantalla sin que esta tablet haga nada. Se
    // vuelven a leer cada pocos segundos.
    //
    // Se eligió preguntar cada X segundos en vez de que el servidor empuje los
    // cambios (SSE o WebSocket) por el sitio donde va a funcionar: en un evento
    // hay mucha interferencia y una conexión abierta se corta a cada rato. Cada
    // consulta es independiente, así que un corte no deja nada colgado: la
    // siguiente vuelve a cuadrar sola. Son dos SELECT, no pesa nada.
    const INTERVALO_STOCK = 12000;
    let temporizadorStock = null;

    function iniciarSondeoStock() {
        detenerSondeoStock();
        temporizadorStock = setInterval(() => {
            // Con la pantalla apagada o la app en segundo plano no hay nadie
            // mirando: no se gasta batería ni se molesta al servidor.
            if (document.hidden) return;
            if (posView.classList.contains('hide')) return;
            refrescarStock();
        }, INTERVALO_STOCK);
    }

    function detenerSondeoStock() {
        if (temporizadorStock) clearInterval(temporizadorStock);
        temporizadorStock = null;
    }

    // Al volver a la app puede haber pasado un buen rato: se refresca ya, sin
    // esperar al siguiente turno del temporizador.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !posView.classList.contains('hide')) refrescarStock();
    });

    /**
     * Relee las existencias y actualiza SOLO las tarjetas que cambiaron, sin
     * repintar la rejilla: un repintado completo cada pocos segundos cortaría
     * el desplazamiento y el toque del cajero a mitad de venta.
     */
    async function refrescarStock() {
        let data;
        try {
            const response = await fetch('/api/productos');
            if (!response.ok) return;
            data = await response.json();
        } catch (err) {
            // Sin conexión momentánea: se reintenta en el siguiente turno.
            console.warn('No se pudo refrescar el stock:', err);
            return;
        }

        const anterior = new Map(products.map(p => [p.id_producto, p.stock_actual]));
        const nuevos = data.productos;

        // Si cambió el catálogo (alta o baja de productos), hay que repintar.
        const mismosProductos = nuevos.length === products.length &&
            nuevos.every(p => anterior.has(p.id_producto));

        products = nuevos;
        categories = data.categorias || categories;

        if (!mismosProductos) {
            renderProducts();
        } else {
            nuevos.forEach(p => {
                if (anterior.get(p.id_producto) !== p.stock_actual) actualizarTarjeta(p.id_producto);
            });
        }

        avisarSiFaltaStock();
    }

    /**
     * Avisa cuando otra tablet se ha llevado algo que este carrito ya tenía.
     * Enterarse aquí es incómodo; enterarse al cobrar, con el cliente delante y
     * el pedido tomado, es peor.
     */
    function avisarSiFaltaStock() {
        if (cart.length === 0) return;

        const problemas = [];
        cart.forEach(item => {
            const enCatalogo = products.find(p => p.id_producto === item.id_producto);
            const disponible = enCatalogo ? enCatalogo.stock_actual : 0;
            if (item.cantidad <= disponible) return;

            problemas.push({ item, disponible });
            // Se ajusta el carrito a lo que queda de verdad: dejarlo pidiendo
            // lo que no existe solo aplaza el rechazo hasta el cobro.
            if (disponible <= 0) {
                cart = cart.filter(c => c.id_producto !== item.id_producto);
            } else {
                item.cantidad = disponible;
            }
        });

        if (problemas.length === 0) return;

        renderCart();
        recalcularTotal();
        problemas.forEach(p => {
            actualizarTarjeta(p.item.id_producto);
            notify(p.disponible <= 0
                ? `Otra caja vendió el último ${p.item.nombre}: se quitó del carrito.`
                : `Solo quedan ${p.disponible} de ${p.item.nombre}: se ajustó el carrito.`,
                'warn', 7000);
        });
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

    // Muestra la rejilla con forma de tarjetas mientras llega el catálogo, para
    // que al aparecer los productos no salte todo de sitio.
    function renderSkeleton(cuantas = 8) {
        const grid = document.getElementById('product-grid');
        grid.innerHTML = '';
        for (let i = 0; i < cuantas; i++) {
            const hueco = document.createElement('div');
            hueco.className = 'skeleton-card';
            grid.appendChild(hueco);
        }
    }

    const emojiDe = p => {
        if (p.tipo_producto === 'BEBIDA_ALCOHOLICA') return '🍺';
        if (p.tipo_producto === 'BEBIDA_NO_ALCOHOLICA') return '🥤';
        if (p.tipo_producto === 'COMIDA') return '🍔';
        return '🍹';
    };

    /**
     * Refresca una sola tarjeta: stock restante y unidades ya en el carrito.
     * Antes cada toque reconstruía la rejilla entera —veinte tarjetas tiradas y
     * vueltas a crear—, y eso se ve como un parpadeo y pierde el desplazamiento.
     */
    function actualizarTarjeta(id_producto, conRebote) {
        const grid = document.getElementById('product-grid');
        const card = grid.querySelector(`.product-card[data-id="${id_producto}"]`);
        if (!card) return;

        const p = products.find(x => x.id_producto === id_producto);
        if (!p) return;

        const enCarrito = cart.find(item => item.id_producto === id_producto);
        const unidades = enCarrito ? enCarrito.cantidad : 0;
        const restante = p.stock_actual - unidades;

        const stockEl = card.querySelector('.stock');
        stockEl.textContent = restante <= 0 ? 'Agotado' : restante + ' u.';
        stockEl.classList.toggle('low', restante > 0 && restante < 10);

        card.classList.toggle('out-of-stock', restante <= 0);

        let badge = card.querySelector('.cart-badge');
        if (unidades > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'cart-badge';
                card.appendChild(badge);
            }
            badge.textContent = unidades;
            if (conRebote) {
                badge.classList.remove('bump');
                void badge.offsetWidth;   // reinicia la animación si se repite
                badge.classList.add('bump');
            }
        } else if (badge) {
            badge.remove();
        }
    }

    // La cascada de entrada sólo se justifica al cargar el catálogo. Si se
    // repitiera al filtrar o al teclear en el buscador —decenas de veces por
    // turno— la rejilla parpadearía en cada letra.
    let animarRejilla = false;

    function renderProducts() {
        const grid = document.getElementById('product-grid');
        const animar = animarRejilla;
        animarRejilla = false;
        grid.innerHTML = '';

        const search = document.getElementById('product-search').value.toLowerCase();
        document.getElementById('search-clear-btn').classList.toggle('hide', search.length === 0);

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

        filtered.forEach((p, i) => {
            // Count already in cart to display stock correctly
            const inCart = cart.find(item => item.id_producto === p.id_producto);
            const unidades = inCart ? inCart.cantidad : 0;
            const displayStock = p.stock_actual - unidades;

            const card = document.createElement('div');
            card.className = `product-card ${animar ? 'enter' : ''} ${displayStock <= 0 ? 'out-of-stock' : ''}`;
            card.dataset.id = p.id_producto;
            if (animar) {
                // Cascada corta: más allá de las primeras filas ya no aporta nada
                // y sólo retrasaría lo que el cajero quiere tocar.
                card.style.animationDelay = Math.min(i, 11) * 25 + 'ms';
            }

            card.innerHTML = `
                <span class="emoji">${emojiDe(p)}</span>
                <h3>${escapeHtml(p.nombre)}</h3>
                <div class="card-foot">
                    <div class="price">${p.precio_venta} Bs.</div>
                    <div class="stock ${displayStock > 0 && displayStock < 10 ? 'low' : ''}">${displayStock <= 0 ? 'Agotado' : displayStock + ' u.'}</div>
                </div>
                ${unidades > 0 ? `<span class="cart-badge">${unidades}</span>` : ''}
                ${displayStock <= 0 ? '<div class="out-of-stock-overlay"><span>Agotado</span></div>' : ''}
            `;

            // El listener va siempre: si el producto se agota por el carrito, es
            // addToCart quien lo frena, y así no hay que recablear la tarjeta.
            card.addEventListener('click', () => addToCart(p));

            grid.appendChild(card);
        });
    }

    document.getElementById('product-search').addEventListener('input', renderProducts);

    document.getElementById('search-clear-btn').addEventListener('click', () => {
        const campo = document.getElementById('product-search');
        campo.value = '';
        campo.focus();
        renderProducts();
    });

    // Cart Lógica
    function addToCart(product) {
        const existing = cart.find(item => item.id_producto === product.id_producto);
        const yaEnCarrito = existing ? existing.cantidad : 0;

        if (yaEnCarrito >= product.stock_actual) {
            notify('No queda stock de ' + product.nombre + '.', 'warn');
            return;
        }

        if (existing) {
            existing.cantidad++;
            actualizarLinea(existing);
        } else {
            cart.push({
                id_producto: product.id_producto,
                nombre: product.nombre,
                precio_venta: parseFloat(product.precio_venta),
                cantidad: 1,
                stock_max: product.stock_actual
            });
            renderCart();
        }

        recalcularTotal();
        actualizarTarjeta(product.id_producto, true);
    }

    // Suma del carrito. Vive aparte porque ahora se recalcula sin repintar nada.
    function recalcularTotal() {
        const total = cart.reduce((s, item) => s + item.precio_venta * item.cantidad, 0);
        document.getElementById('cart-total-amount').textContent = `${total.toFixed(2)} Bs.`;

        const contador = document.getElementById('cart-count');
        contador.textContent = cart.length;
        contador.classList.toggle('tiene', cart.length > 0);

        updatePaymentDetails(total);
        return total;
    }

    // Cambia sólo los números de una línea ya pintada, sin tocar el resto del
    // carrito: subir una cantidad no debe hacer parpadear toda la lista.
    function actualizarLinea(item) {
        const fila = document.querySelector(`.cart-item[data-id="${item.id_producto}"]`);
        if (!fila) return renderCart();

        const sub = item.precio_venta * item.cantidad;
        fila.querySelector('.price').textContent =
            `${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.`;
        fila.querySelector('.qty').textContent = item.cantidad;
    }

    function quitarDelCarrito(id_producto) {
        cart = cart.filter(c => c.id_producto !== id_producto);
        renderCart();
        recalcularTotal();
        actualizarTarjeta(id_producto);
    }

    function renderCart() {
        const container = document.getElementById('cart-items');
        // Las líneas que ya estaban no vuelven a animarse; sólo entra la nueva.
        const yaPintadas = new Set(
            [...container.querySelectorAll('.cart-item')].map(el => el.dataset.id)
        );
        container.innerHTML = '';

        if (cart.length === 0) {
            container.innerHTML = `<div class="empty-cart-msg">El carrito está vacío</div>`;
            recalcularTotal();
            return;
        }

        cart.forEach(item => {
            const sub = item.precio_venta * item.cantidad;

            const div = document.createElement('div');
            div.className = 'cart-item' + (yaPintadas.has(String(item.id_producto)) ? '' : ' enter');
            div.dataset.id = item.id_producto;
            div.innerHTML = `
                <div class="cart-item-info">
                    <h4>${escapeHtml(item.nombre)}</h4>
                    <div class="price">${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.</div>
                </div>
                <div class="cart-item-controls">
                    <button class="cart-qty-btn decrease-btn" aria-label="Quitar uno">−</button>
                    <span class="qty">${item.cantidad}</span>
                    <button class="cart-qty-btn increase-btn" aria-label="Añadir uno">+</button>
                    <button class="remove-item-btn" aria-label="Quitar del carrito" title="Quitar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>
                        </svg>
                    </button>
                </div>
            `;

            // Qty listeners
            div.querySelector('.decrease-btn').addEventListener('click', () => {
                if (item.cantidad > 1) {
                    item.cantidad--;
                    actualizarLinea(item);
                    recalcularTotal();
                    actualizarTarjeta(item.id_producto, true);
                } else {
                    quitarDelCarrito(item.id_producto);
                }
            });

            div.querySelector('.increase-btn').addEventListener('click', () => {
                // Se consulta el stock vivo, no el que había al añadirlo: otra
                // tablet puede haber vendido unidades desde entonces.
                const enCatalogo = products.find(p => p.id_producto === item.id_producto);
                const tope = enCatalogo ? enCatalogo.stock_actual : item.stock_max;
                if (item.cantidad >= tope) {
                    notify('No queda stock de ' + item.nombre + '.', 'warn');
                    return;
                }
                item.cantidad++;
                actualizarLinea(item);
                recalcularTotal();
                actualizarTarjeta(item.id_producto, true);
            });

            div.querySelector('.remove-item-btn').addEventListener('click', () => {
                quitarDelCarrito(item.id_producto);
            });

            container.appendChild(div);
        });

        recalcularTotal();
    }

    document.getElementById('clear-cart').addEventListener('click', () => {
        cart = [];
        renderCart();
        renderProducts();
    });

    // ==========================================
    // 3. COBRO
    // ==========================================
    // El cobro ocurre en una sola pantalla: total arriba, forma de pago en
    // pestañas y un botón que confirma. Antes había que ir añadiendo pagos de
    // uno en uno con un "+", que con cola en la barra es un estorbo.
    let orderTotal = 0;

    const METODOS = {
        1: { nombre: 'Efectivo', ref: 'EFECTIVO-CAJA' },
        2: { nombre: 'Tarjeta', ref: 'TARJETA-OP' },
        3: { nombre: 'Código QR', ref: 'QR-MONEY' },
        4: { nombre: 'Transferencia', ref: 'TRANSF-OP' }
    };
    const EFECTIVO = 1;

    let metodoActivo = EFECTIVO;   // id_metodo_pago, o 'mixto'
    let efectivoRecibido = 0;      // billete con el que paga, sólo para el cambio

    const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const payModal = document.getElementById('payment-modal');
    const payRecibidoInput = document.getElementById('pay-recibido');
    const payMixtoEfectivo = document.getElementById('pay-mixto-efectivo');
    const payMixtoResto = document.getElementById('pay-mixto-resto');
    const payMixtoMetodo = document.getElementById('pay-mixto-metodo');
    const payError = document.getElementById('pay-error');

    // El carrito ya no lleva resumen de pagos: sólo el total y el botón de
    // cobrar, que se habilita en cuanto hay algo que cobrar.
    function updatePaymentDetails(total) {
        orderTotal = total;
        document.getElementById('finalize-order-btn').disabled = !(total > 0);
    }

    function mostrarErrorPago(mensaje) {
        if (!mensaje) {
            payError.classList.add('hide');
            return;
        }
        payError.textContent = mensaje;
        payError.classList.remove('hide');
    }

    const QR = 3;   // id_metodo_pago del código QR

    function seleccionarMetodo(metodo) {
        metodoActivo = metodo;
        mostrarErrorPago('');

        document.querySelectorAll('.pay-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.metodo === String(metodo));
        });

        // Sólo el efectivo necesita cambio, sólo el mixto necesita repartir y
        // sólo el QR necesita la referencia del comprobante.
        document.getElementById('pay-panel-efectivo')
            .classList.toggle('hide', metodo !== EFECTIVO);
        document.getElementById('pay-panel-mixto')
            .classList.toggle('hide', metodo !== 'mixto');
        document.getElementById('pay-panel-qr')
            .classList.toggle('hide', metodo !== QR);

        if (metodo === 'mixto') recalcularMixto();
        if (metodo === QR) prepararPanelQr();
    }

    // ==========================================
    // COBRO POR QR
    // ==========================================
    // Este sistema NO emite el QR ni comprueba con el banco si el pago entró:
    // no tiene credenciales ni conexión durante el evento. El cajero enseña el
    // código de su propia banca móvil, mira el comprobante del cliente y teclea
    // la referencia, que es lo que después permite cuadrar la caja contra el
    // extracto bancario.
    function prepararPanelQr() {
        document.getElementById('qr-cobro-monto').textContent = orderTotal.toFixed(2) + ' Bs.';
        document.getElementById('pay-referencia').value = '';
    }

    // Se escribe el efectivo y el resto se rellena solo, como en el modal de
    // Snack Point: el cajero nunca tiene que restar de cabeza.
    function recalcularMixto() {
        const efectivo = parseFloat(payMixtoEfectivo.value) || 0;
        const resto = round2(Math.max(0, orderTotal - efectivo));
        payMixtoResto.value = resto.toFixed(2);

        const etiqueta = METODOS[Number(payMixtoMetodo.value)];
        document.getElementById('pay-mixto-resto-label').textContent =
            'Falta en ' + (etiqueta ? etiqueta.nombre : 'otro método');

        mostrarErrorPago(efectivo > orderTotal + 0.005
            ? 'El efectivo no puede superar el total de la comanda.'
            : '');
    }

    function renderCambio(destacar) {
        const caja = document.getElementById('pay-change-box');
        const valor = document.getElementById('pay-change-amount');
        const cambio = round2(efectivoRecibido - orderTotal);

        if (efectivoRecibido > 0 && cambio > 0) {
            valor.textContent = `${cambio.toFixed(2)} Bs.`;
            caja.classList.remove('hide');
            if (destacar) {
                caja.classList.remove('change-pop');
                void caja.offsetWidth;   // reinicia la animación si se repite
                caja.classList.add('change-pop');
            }
        } else {
            caja.classList.add('hide');
        }
    }

    // Identificador de ESTE intento de cobro. Se genera al abrir el modal y se
    // mantiene mientras el carrito sea el mismo, de modo que si hay que
    // reintentar —porque se perdió la respuesta— el servidor reconozca que es
    // la misma venta y no la guarde otra vez. Sólo cambia cuando la venta se
    // cierra de verdad y empieza una nueva.
    let claveCobro = null;

    function nuevaClaveCobro() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        // Respaldo para navegadores viejos: hora + azar basta para no repetirse
        // dentro de una misma barra.
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }

    function abrirModalCobro() {
        if (cart.length === 0 || orderTotal <= 0) return;

        if (!claveCobro) claveCobro = nuevaClaveCobro();
        efectivoRecibido = 0;
        payRecibidoInput.value = '';
        payMixtoEfectivo.value = '';
        mostrarErrorPago('');
        document.getElementById('pay-total').textContent = `${orderTotal.toFixed(2)} Bs.`;
        seleccionarMetodo(EFECTIVO);
        renderCambio();
        payModal.classList.remove('hide');
    }

    function cerrarModalCobro() {
        payModal.classList.add('hide');
    }

    /**
     * Traduce lo elegido en el modal a la lista de pagos que espera el servidor.
     * Devuelve null si algo no cuadra, dejando el motivo escrito en el modal.
     */
    function construirPagos() {
        const referencia = id => {
            const meta = METODOS[id] || { ref: 'PAGO' };
            // Si el cajero anotó la referencia del comprobante, esa manda: es la
            // que sirve para cuadrar con el extracto del banco. El número
            // inventado sólo rellena cuando no hay ninguna.
            const anotada = document.getElementById('pay-referencia').value.trim();
            if (id === QR && anotada) return anotada.slice(0, 40);
            return meta.ref + '-' + Math.floor(100000 + Math.random() * 900000);
        };
        const pago = (id, monto) => ({
            id_metodo_pago: id,
            nombre_metodo: (METODOS[id] || {}).nombre || 'Pago',
            monto: round2(monto),
            referencia: referencia(id)
        });

        if (metodoActivo !== 'mixto') {
            return [pago(metodoActivo, orderTotal)];
        }

        const efectivo = round2(parseFloat(payMixtoEfectivo.value) || 0);
        const idResto = Number(payMixtoMetodo.value);
        const resto = round2(parseFloat(payMixtoResto.value) || 0);

        if (efectivo <= 0) {
            mostrarErrorPago('Escribe cuánto paga en efectivo.');
            return null;
        }
        if (Math.abs(efectivo + resto - orderTotal) > 0.01) {
            mostrarErrorPago('Los montos no cuadran con el total.');
            return null;
        }
        // Si el efectivo cubre todo, el pago mixto se queda en uno solo: no
        // tiene sentido guardar una línea de 0.00 en el otro método.
        return resto > 0 ? [pago(EFECTIVO, efectivo), pago(idResto, resto)] : [pago(EFECTIVO, efectivo)];
    }

    // ---- Interacciones del modal ----
    document.querySelectorAll('.pay-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const m = tab.dataset.metodo;
            seleccionarMetodo(m === 'mixto' ? 'mixto' : Number(m));
        });
    });

    // Billetes de uso corriente: el cajero toca el que le dan en vez de teclear
    // la cifra, que con prisa y a oscuras es donde más se equivoca.
    document.querySelectorAll('.quick-cash-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (orderTotal <= 0) return;
            efectivoRecibido = btn.dataset.cash === 'exacto'
                ? orderTotal
                : Number(btn.dataset.cash);
            payRecibidoInput.value = efectivoRecibido.toFixed(2);
            renderCambio(true);
        });
    });

    payRecibidoInput.addEventListener('input', () => {
        efectivoRecibido = round2(parseFloat(payRecibidoInput.value) || 0);
        renderCambio();
    });

    payMixtoEfectivo.addEventListener('input', recalcularMixto);
    payMixtoMetodo.addEventListener('change', recalcularMixto);

    document.getElementById('pay-close-btn').addEventListener('click', cerrarModalCobro);
    payModal.addEventListener('click', e => {
        if (e.target === payModal) cerrarModalCobro();
    });

    // FINALIZATION & CHECKOUT SUBMIT
    // Una comanda tarda unas décimas en guardarse. Sin este cerrojo, dos toques
    // seguidos en una pantalla que no ha respondido todavía mandan la venta dos
    // veces: se cobra una y se descuenta el stock dos. El botón se queda en
    // "Guardando..." hasta que el servidor contesta.
    let guardandoComanda = false;

    // El botón del carrito ya no cobra: abre el modal donde se elige el pago.
    document.getElementById('finalize-order-btn').addEventListener('click', abrirModalCobro);

    document.getElementById('pay-confirm-btn').addEventListener('click', async () => {
        if (cart.length === 0 || orderTotal <= 0) return;
        if (guardandoComanda) return;

        // Se arma la lista de pagos antes de bloquear nada: si los montos no
        // cuadran, el modal se queda abierto con el motivo escrito.
        const pagos = construirPagos();
        if (!pagos) return;
        payments = pagos;

        const boton = document.getElementById('pay-confirm-btn');
        const etiquetaOriginal = boton.textContent;
        guardandoComanda = true;
        boton.disabled = true;
        boton.classList.add('is-busy');
        boton.textContent = 'COBRANDO...';

        const restaurarBoton = () => {
            guardandoComanda = false;
            boton.disabled = false;
            boton.classList.remove('is-busy');
            boton.textContent = etiquetaOriginal;
        };

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
            metodos_pago: payments,
            // Marca este intento de cobro. Si hay que reintentar, viaja la misma
            // y el servidor devuelve la comanda ya guardada en vez de crear otra.
            clave_idempotencia: claveCobro
        };

        try {
            const response = await fetch('/api/comanda', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData)
            });
            const result = await response.json();

            if (result.success) {
                cerrarModalCobro();
                // El servidor recalcula precios y total desde la base de datos:
                // el ticket se imprime con esos valores, no con los del navegador.
                triggerThermalPrint(result.id_comanda, Object.assign({}, bodyData, {
                    total: typeof result.total === 'number' ? result.total : bodyData.total,
                    items: (result.items && result.items.length) ? result.items : bodyData.items,
                    recibido: metodoActivo === EFECTIVO ? efectivoRecibido : 0
                }));
                // La venta se cerró: la próxima empieza con clave nueva.
                claveCobro = null;
                if (result.repetida) {
                    notify('Esa venta ya estaba guardada como ' +
                        (result.ref_comanda || refComanda(result.id_comanda)) +
                        '. No se cobró ni se descontó dos veces.', 'warn', 8000);
                } else {
                    notify('Comanda ' + (result.ref_comanda || refComanda(result.id_comanda)) + ' guardada.', 'ok');
                }
                // Otra tablet puede haber vendido mientras tanto: se releen las
                // existencias para no ofrecer lo que ya no queda.
                refrescarStock();
            } else {
                notify(result.message || 'No se pudo guardar la comanda.', 'error');
                // Si el rechazo fue por existencias, el carrito está pidiendo algo
                // que otra tablet ya vendió: hay que releer el stock o el cajero
                // reintentaría en bucle contra el mismo error.
                if (/stock/i.test(result.message || '')) refrescarStock();
            }
        } catch (err) {
            // Puede que la venta SÍ se guardara y sea la respuesta la que se
            // perdió. Decir "no se guardó" a secas llevaría a cobrar dos veces.
            notify('Se perdió la conexión al cobrar. Comprueba en el panel de admin ' +
                   'si la comanda se guardó ANTES de volver a cobrarla.', 'error', 12000);
        } finally {
            restaurarBoton();
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
        // Formato fijo dd/mm/aaaa hh:mm. toLocaleString() mete los segundos y
        // una coma, que en 32 columnas de papel sólo estorban.
        const dosCifras = n => String(n).padStart(2, '0');
        const hhmm = dosCifras(fecha.getHours()) + ':' + dosCifras(fecha.getMinutes());
        const ddmmaaaa = dosCifras(fecha.getDate()) + '/' + dosCifras(fecha.getMonth() + 1) +
            '/' + fecha.getFullYear();

        return {
            id: id_comanda,
            // Lo que se imprime y se canta: N-47. Si el servidor no dio
            // identidad, refComanda devuelve el '#47' de siempre.
            ref: data.ref_comanda || refComanda(id_comanda),
            instancia: data.instancia || instancia.nombre,
            fecha: ddmmaaaa + ' ' + hhmm,
            hora: hhmm,
            // La barra del ticket sale de los datos del evento, que es lo que
            // el encargado escribió para esta barra; si no hay nada, se cae a
            // la barra del cajero.
            barra: configEvento.barra || data.nombre_barra ||
                   (currentUser ? currentUser.nombre_barra : 'Barra'),
            cajero: data.nombre_cajero || (currentUser ? currentUser.nombre : 'Cajero'),
            mesero: data.nombre_mesero || (currentWaiter ? currentWaiter.nombre : 'Mesero'),
            total: Number(data.total) || 0,
            // Efectivo que entregó el cliente. Sólo sirve para imprimir el
            // cambio: en la base se guarda lo cobrado, no el billete.
            recibido: Number(data.recibido) || 0,
            observaciones: data.observaciones || 'Sin observaciones',
            items: (data.items || []).map(item => {
                const known = products.find(p => p.id_producto === item.id_producto);
                return {
                    cantidad: item.cantidad,
                    nombre: item.nombre || (known ? known.nombre : 'Producto'),
                    // El ticket imprime el precio unitario, así que si la venta no
                    // lo trae se deduce del subtotal en vez de dejarlo en blanco.
                    precio_unitario: item.precio_unitario != null
                        ? Number(item.precio_unitario)
                        : (known ? Number(known.precio_venta) : null),
                    subtotal: Number(item.subtotal) || 0
                };
            }),
            pagos: (data.metodos_pago || payments).map(pay => {
                const metodo = pay.nombre_metodo || pay.nombre || 'Pago';
                // La referencia arranca con el método (EFECTIVO-CAJA-123456). Sólo
                // se añade cuando aporta algo: repetir "Efectivo (EFECTIVO)" no.
                const cabeza = pay.referencia ? String(pay.referencia).split('-')[0] : '';
                const prefijo = cabeza && cabeza.toLowerCase() !== metodo.toLowerCase()
                    ? ' (' + cabeza + ')'
                    : '';
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
            barra: configEvento.barra || (currentUser ? currentUser.nombre_barra : 'Barra'),
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
            efectivoRecibido = 0;
            metodoActivo = EFECTIVO;
            document.getElementById('cart-observations').value = '';

            posView.classList.add('hide');
            showWaiterModal();
        }
    });

    // ==========================================
    // 5. ADMINISTRATOR PANEL CONTROLLER
    // ==========================================
    function showAdminView() {
        detenerSondeoStock();
        cargarConfiguracion().then(pintarConfiguracion);
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

            // Con una sola barra no hay reparto que enseñar: la barra de
            // progreso estaría siempre al 100 % y el porcentaje sobra. Se
            // enseña el nombre y lo recaudado, que es lo único que informa.
            const unaSola = barNames.length === 1;

            barNames.forEach(name => {
                const amount = salesByBar[name];
                const pct = totalRecaudado > 0 ? (amount / totalRecaudado) * 100 : 0;

                const div = document.createElement('div');
                div.className = 'sales-bar-item';
                div.innerHTML = unaSola
                    ? `
                    <div class="sales-bar-info">
                        <span>${escapeHtml(name)}</span>
                        <strong>${amount.toFixed(2)} Bs.</strong>
                    </div>
                `
                    : `
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

    // ==========================================
    // DATOS DEL EVENTO
    // ==========================================
    // Evento, fecha, lugar, barra y responsable. Van en la tabla
    // `configuracion` y encabezan los tickets y el reporte de cierre. Se
    // rellenan una vez por evento.
    let configEvento = { evento: '', fecha: '', lugar: '', barra: '', responsable: '' };

    async function cargarConfiguracion() {
        try {
            const res = await fetch('/api/configuracion');
            if (res.ok) configEvento = await res.json();
        } catch (err) {
            console.warn('No se pudo leer la configuración del evento:', err);
        }
        return configEvento;
    }

    function pintarConfiguracion() {
        ['evento', 'fecha', 'lugar', 'barra', 'responsable'].forEach(campo => {
            const el = document.getElementById('cfg-' + campo);
            if (el) el.value = configEvento[campo] || '';
        });
    }

    document.getElementById('cfg-guardar-btn').addEventListener('click', async () => {
        const boton = document.getElementById('cfg-guardar-btn');
        const cuerpo = {};
        ['evento', 'fecha', 'lugar', 'barra', 'responsable'].forEach(campo => {
            cuerpo[campo] = document.getElementById('cfg-' + campo).value;
        });

        boton.disabled = true;
        try {
            const res = await fetch('/api/admin/configuracion-evento', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cuerpo)
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || 'error');

            configEvento = data.configuracion;
            pintarConfiguracion();
            // El nombre de la barra ES la identidad: al cambiarlo cambian la
            // etiqueta de la pantalla, el título de la pestaña y el prefijo de
            // las comandas, así que se recargan sin reiniciar nada.
            if (data.instancia) {
                instancia = data.instancia;
                document.querySelectorAll('.instancia-badge').forEach(el => {
                    el.textContent = instancia.nombre;
                    el.classList.remove('hide');
                });
                document.title = 'MasterDrinks · ' + instancia.nombre;
                // La ficha de alta de cajeros enseña esta misma barra, así que
                // se repinta aquí y no hace falta salir y volver a la pestaña.
                pintarBarraDelCajero();
            }
            notify('Datos del evento guardados. Las comandas serán ' +
                   (data.instancia ? data.instancia.prefijo : '') + '-1, ' +
                   (data.instancia ? data.instancia.prefijo : '') + '-2...', 'ok', 6000);
        } catch (err) {
            notify(err.message || 'No se pudieron guardar los datos.', 'error');
        } finally {
            boton.disabled = false;
        }
    });

    // ==========================================
    // REPORTE DE CIERRE EN PDF
    // ==========================================
    // El PDF lo genera el servidor: aquí sólo se elige el rango y se pide.
    // Sumar en el navegador daría cifras distintas según cuándo se abrió la
    // pestaña, y un cierre de caja tiene que cuadrar con la base siempre.
    function rangoReporte() {
        const desde = document.getElementById('rep-desde').value;
        const hasta = document.getElementById('rep-hasta').value;
        const params = new URLSearchParams();
        if (desde) params.set('desde', desde);
        if (hasta) params.set('hasta', hasta);
        return { desde, hasta, query: params.toString() ? '?' + params.toString() : '' };
    }

    function validarRango(r) {
        if (r.desde && r.hasta && r.desde > r.hasta) {
            notify('La fecha "Desde" es posterior a la de "Hasta".', 'warn');
            return false;
        }
        return true;
    }

    document.getElementById('rep-hoy-btn').addEventListener('click', () => {
        const hoy = new Date();
        const iso = hoy.getFullYear() + '-' +
            String(hoy.getMonth() + 1).padStart(2, '0') + '-' +
            String(hoy.getDate()).padStart(2, '0');
        document.getElementById('rep-desde').value = iso;
        document.getElementById('rep-hasta').value = iso;
        notify('Rango puesto en hoy.', 'info');
    });

    document.getElementById('rep-todo-btn').addEventListener('click', () => {
        document.getElementById('rep-desde').value = '';
        document.getElementById('rep-hasta').value = '';
        notify('Rango puesto en todo el evento.', 'info');
    });

    // Resumen en pantalla antes de descargar: evita generar el PDF para
    // descubrir que el rango elegido no tiene ventas.
    document.getElementById('rep-ver-btn').addEventListener('click', async () => {
        const r = rangoReporte();
        if (!validarRango(r)) return;

        const caja = document.getElementById('rep-preview');
        caja.classList.remove('hide');
        caja.textContent = 'Calculando...';

        try {
            const res = await fetch('/api/admin/reporte' + r.query);
            if (!res.ok) throw new Error('respuesta ' + res.status);
            const d = await res.json();

            const fila = (etiqueta, valor, clase) =>
                `<div class="rep-row ${clase || ''}"><span>${escapeHtml(etiqueta)}</span>` +
                `<strong>${escapeHtml(valor)}</strong></div>`;

            caja.innerHTML =
                fila('Recaudado', d.resumen.recaudado.toFixed(2) + ' Bs.', 'destacada') +
                fila('Comandas cobradas', String(d.resumen.validas)) +
                fila('Ticket medio', d.resumen.ticket_medio.toFixed(2) + ' Bs.') +
                fila('Unidades vendidas', String(d.resumen.unidades)) +
                fila('Anuladas', d.resumen.anuladas + ' (' + d.resumen.importe_anulado.toFixed(2) + ' Bs.)',
                    d.resumen.anuladas > 0 ? 'alerta' : '') +
                '<div class="rep-separador"></div>' +
                d.porMetodo.map(m => fila(m.metodo, Number(m.importe).toFixed(2) + ' Bs.')).join('') +
                (d.porMetodo.length === 0 ? '<div class="rep-row"><span>Sin cobros en este rango</span></div>' : '');
        } catch (err) {
            caja.textContent = 'No se pudo calcular el reporte.';
            notify('No se pudo calcular el reporte.', 'error');
        }
    });

    document.getElementById('rep-pdf-btn').addEventListener('click', async () => {
        const r = rangoReporte();
        if (!validarRango(r)) return;

        const boton = document.getElementById('rep-pdf-btn');
        const etiqueta = boton.textContent;
        boton.disabled = true;
        boton.classList.add('is-busy');
        boton.textContent = 'Generando...';

        try {
            // Se descarga por fetch en vez de con un enlace directo para poder
            // avisar si falla: un <a href> que devuelve un error 500 deja al
            // admin mirando una pestaña en blanco sin saber qué pasó.
            const res = await fetch('/api/admin/reporte.pdf' + r.query);
            if (!res.ok) throw new Error('respuesta ' + res.status);

            const blob = await res.blob();
            const cabecera = res.headers.get('Content-Disposition') || '';
            const coincide = cabecera.match(/filename="([^"]+)"/);
            const nombre = coincide ? coincide[1] : 'Cierre_Caja_MasterDrinks.pdf';

            const url = URL.createObjectURL(blob);
            const enlace = document.createElement('a');
            enlace.href = url;
            enlace.download = nombre;
            document.body.appendChild(enlace);
            enlace.click();
            enlace.remove();
            // Se libera con margen: si se revoca al instante, Android puede
            // quedarse sin la fuente antes de terminar de guardar el archivo.
            setTimeout(() => URL.revokeObjectURL(url), 20000);

            notify('Reporte descargado: ' + nombre, 'ok', 6000);
        } catch (err) {
            console.error('Error al descargar el reporte:', err);
            notify('No se pudo generar el PDF del reporte.', 'error');
        } finally {
            boton.disabled = false;
            boton.classList.remove('is-busy');
            boton.textContent = etiqueta;
        }
    });

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
                            <span class="comanda-card-id">Comanda ${escapeHtml(refComanda(c.id_comanda))}</span>
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
        document.getElementById('void-order-id-label').textContent = refComanda(id_comanda);
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
                notify(data.message || 'No se pudo anular la comanda.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
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
                notify('Categoría creada.', 'ok');
                document.getElementById('form-create-category').reset();
                loadCatalogSetup(); // Refresh product selector
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
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
                notify('Producto creado.', 'ok');
                document.getElementById('form-create-product').reset();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // TAB: PERSONAL & BARRAS SETUP
    async function loadPersonalSetup() {
        try {
            const response = await fetch('/api/admin/configuracion');
            const data = await response.json();

            // La barra no se elige: es la de este servidor. Se enseña sólo
            // para que quede claro dónde va a poder cobrar el cajero.
            pintarBarraDelCajero();

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

    // La barra de esta instancia, tal como se rotuló en Datos del evento. Ya no
    // se crean barras desde el panel: un servidor es una barra.
    function pintarBarraDelCajero() {
        const casilla = document.getElementById('caj-barra');
        if (casilla) casilla.value = instancia.nombre || '—';
    }

    // Form: Create Cajero
    document.getElementById('form-create-cajero').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('caj-name').value;
        const usuario = document.getElementById('caj-user').value;
        const password = document.getElementById('caj-pass').value;

        try {
            const response = await fetch('/api/admin/cajeros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, usuario, password, id_admin: currentUser.id_admin, id_evento: currentUser.id_evento })
            });
            const data = await response.json();

            if (data.success) {
                notify('Cajero registrado.', 'ok');
                document.getElementById('form-create-cajero').reset();
                loadPersonalSetup();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
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
                notify('Mesero registrado.', 'ok');
                document.getElementById('form-create-mesero').reset();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
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
                notify('Stock ajustado. Ahora hay ' + data.stock_nuevo + ' unidades.', 'ok');
                document.getElementById('form-adjust-stock').reset();
                loadStockSetup(); // Refresh view
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
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
            notify('El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes.', 'error');
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
