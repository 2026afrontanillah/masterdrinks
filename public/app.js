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
    // pantalla y en los tickets. El nombre lo pone el encargado en el panel y
    // suele cambiar de un evento a otro.
    let instancia = { nombre: '' };

    // El número de comanda es sólo el número: es lo que el mesero canta en voz
    // alta y lo que el cliente busca en su ticket.
    const refComanda = id => String(id);

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

            // Si el número que sale aquí no coincide con el que imprimió el
            // servidor al arrancar, esta tablet está corriendo código viejo de
            // su caché: hay que recargar la página.
            if (instancia.version) {
                document.querySelectorAll('.version-num').forEach(el => {
                    el.textContent = instancia.version;
                });
            }
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

    // Deja el POS como recién abierto.
    //
    // Sin esto, el mesero que armaba un pedido y se iba sin cobrar se lo dejaba
    // puesto al siguiente: entraba con su PIN y se encontraba el carrito de
    // otro, con el contador marcando productos que él no había tocado. Si lo
    // cobraba sin mirar, la venta salía mal y el stock también.
    function vaciarCarrito() {
        const habia = cart.length;
        const tocados = cart.map(i => i.id_producto);

        cart = [];
        payments = [];
        efectivoRecibido = 0;
        metodoActivo = EFECTIVO;

        const obs = document.getElementById('cart-observations');
        if (obs) obs.value = '';

        renderCart();
        recalcularTotal();
        // Las tarjetas llevan encima el número de unidades ya añadidas: hay que
        // quitárselo, o seguirían marcando un carrito que ya no existe.
        tocados.forEach(id => actualizarTarjeta(id, false));
        return habia;
    }

    // Salida al login, escondida detrás de una pulsación larga.
    //
    // El botón visible que había aquí se quitó: la barra es siempre la misma y
    // el cajero no cambia durante el turno, así que sólo servía para salirse
    // sin querer y tener que volver a teclear usuario y contraseña con gente
    // esperando. Pero el encargado sí necesita llegar al panel para ajustar
    // stock o sacar el cierre, y sin ninguna salida habría que recargar la
    // página en el navegador, que en una tablet no es evidente.
    //
    // Tres segundos: lo bastante largo como para que nadie lo descubra por
    // accidente apoyando el dedo, lo bastante corto para no desesperar.
    const ESPERA_SALIDA = 3000;
    let temporizadorSalida = null;

    function cerrarSesionCajero() {
        vaciarCarrito();
        currentUser = null;
        currentWaiter = null;
        clearPin();
        waiterModal.classList.add('hide');
        posView.classList.add('hide');
        loginView.classList.remove('hide');
    }

    const salidaOculta = document.getElementById('salida-oculta');
    if (salidaOculta) {
        const empezar = () => {
            cancelar();
            salidaOculta.classList.add('cargando');
            temporizadorSalida = setTimeout(() => {
                salidaOculta.classList.remove('cargando');
                vibrar([30, 60, 30]);
                notify('Sesión del cajero cerrada.', 'ok');
                cerrarSesionCajero();
            }, ESPERA_SALIDA);
        };
        const cancelar = () => {
            salidaOculta.classList.remove('cargando');
            if (temporizadorSalida) clearTimeout(temporizadorSalida);
            temporizadorSalida = null;
        };

        // pointer* cubre dedo y ratón con los mismos manejadores. 'pointerleave'
        // y 'pointercancel' hacen falta porque en una tablet el dedo se desliza
        // fuera del icono sin llegar a levantarse.
        salidaOculta.addEventListener('pointerdown', empezar);
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(
            ev => salidaOculta.addEventListener(ev, cancelar));
    }

    // Lock POS (Switch waiter)
    document.getElementById('lock-pos-btn').addEventListener('click', () => {
        // Se avisa de lo que se descarta: si el mesero se equivocó de botón,
        // tiene que enterarse ahora y no cuando vuelva y no encuentre nada.
        const habia = vaciarCarrito();
        if (habia > 0) {
            notify('Se vació el carrito: ' + habia +
                   (habia === 1 ? ' producto sin cobrar.' : ' productos sin cobrar.'), 'warn');
        }
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
            // Sólo las existencias, no el catálogo entero. Con una foto por
            // producto, pedir /api/productos cada doce segundos son 600 KB por
            // tablet y por sondeo: sobre el WiFi de un teléfono eso deja sin
            // antena a las ventas, que es lo único que no puede esperar.
            const response = await fetch('/api/stock');
            if (!response.ok) return;
            data = await response.json();
        } catch (err) {
            // Sin conexión momentánea: se reintenta en el siguiente turno.
            console.warn('No se pudo refrescar el stock:', err);
            return;
        }

        const llegado = new Map((data.stock || []).map(p => [p.id, p.s]));

        // Un alta o una baja de producto cambia la lista de ids: eso sí obliga a
        // recargar el catálogo entero, pero pasa una vez cada muchas horas.
        const mismosProductos = llegado.size === products.length &&
            products.every(p => llegado.has(p.id_producto));

        if (!mismosProductos) {
            await fetchProductsAndMenu();
            avisarSiFaltaStock();
            return;
        }

        // Sólo se tocan las tarjetas cuyo número cambió. Repintar la rejilla
        // entera cada pocos segundos cortaría el desplazamiento y el toque del
        // cajero a mitad de venta.
        products.forEach(p => {
            const nuevo = llegado.get(p.id_producto);
            if (nuevo === undefined || nuevo === p.stock_actual) return;
            p.stock_actual = nuevo;
            actualizarTarjeta(p.id_producto);
        });

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

        // Todas las unidades comprometidas: las que van sueltas y las que van
        // de acompañante dentro de otra línea. La insignia de la tarjeta tiene
        // que contarlas todas, porque todas salen del mismo almacén.
        const unidades = unidadesEnCarrito(id_producto);
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

    // Dirección de la foto de un producto. Lleva el tamaño dentro: al cambiar
    // la foto cambia la dirección, y el navegador —que la tiene cacheada un
    // año— se entera de que hay una nueva.
    const urlFoto = p => (p && p.tiene_foto)
        ? '/api/producto/' + p.id_producto + '/foto?v=' + (p.foto_v || 0)
        : '';

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

            // Con foto se ve la foto; sin ella, el dibujito de siempre. Buscar
            // una botella concreta entre veinte es mucho más rápido por la
            // imagen que leyendo nombres que empiezan todos igual.
            //
            // El data URI viene validado por el servidor (data:image/... y
            // base64 a secas), así que no puede colar comillas ni salirse del
            // atributo.
            const foto = urlFoto(p);
            const visual = foto
                ? `<img class="product-foto" src="${foto}" alt="" loading="lazy" decoding="async">`
                : `<span class="emoji">${emojiDe(p)}</span>`;

            card.innerHTML = `
                ${visual}
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

    // ==========================================
    // CONTADOR DEL TURNO
    // ==========================================
    // Lo que lleva cobrado ESTA tablet desde que se abrió la caja. No sale de
    // la base: es lo que ha pasado por delante de este cajero, que es justo lo
    // que le preguntan ("¿cuánto llevas?") y lo que va a tener que cuadrar con
    // el efectivo de su cajón al cerrar.
    //
    // Vive en la sesión y no en el servidor a propósito: si se recarga la
    // página vuelve a cero, y eso es correcto —lo que cuenta para el cierre es
    // el reporte, no este número—. Aquí sirve para orientarse, no para cuadrar.
    let turno = { total: 0, comandas: 0 };

    function anotarEnElTurno(importe) {
        turno.total += Number(importe) || 0;
        turno.comandas += 1;
        pintarTurno();
    }

    function pintarTurno() {
        const total = document.getElementById('turno-total');
        const n = document.getElementById('turno-comandas');
        if (total) total.textContent = turno.total.toFixed(2);
        if (n) n.textContent = turno.comandas;
    }

    // Vibración corta al tocar un producto.
    //
    // En una barra a oscuras y con la música alta no se oye el toque ni se ve
    // bien la pantalla: el golpecito en la mano es la única confirmación fiable
    // de que el producto entró.
    //
    // 15 ms no se notaban con la tablet apoyada en la mesa: el mueble se come
    // el pulso. 28 ms sí, y siguen sin cansar tras doscientos toques.
    //
    // No todos los navegadores la tienen (iOS no), y algunos exigen que la
    // página ya haya recibido una interacción. Por eso va envuelto: si no puede
    // vibrar, la venta sigue igual.
    function vibrar(ms) {
        try {
            if (navigator.vibrate) navigator.vibrate(ms);
        } catch (err) { /* sin vibración: no es motivo para cortar una venta */ }
    }

    // El carrito se mueve hasta la línea que acaba de cambiar.
    //
    // No siempre es la última: si vuelves a pulsar un whisky que ya estaba
    // arriba del todo, lo que hay que enseñar es esa línea, no el final de la
    // lista. Bajar siempre al fondo dejaba al cajero mirando un sitio donde no
    // había pasado nada.
    //
    // Se mueve con animación y no de golpe para que se vea el recorrido: así
    // se entiende que la lista se desplazó, en vez de parecer que cambió sola.
    function mostrarLinea(id_producto) {
        const lista = document.getElementById('cart-items');
        if (!lista) return;

        const fila = lista.querySelector(`.cart-item[data-id="${id_producto}"]`);
        // requestAnimationFrame: si se llama antes de que el navegador haya
        // pintado la línea nueva, la altura todavía es la de antes y el scroll
        // se queda a media línea del final.
        // requestAnimationFrame: si se llama antes de que el navegador haya
        // pintado la línea, su posición todavía es la de antes y el desplazamiento
        // se queda corto.
        requestAnimationFrame(() => {
            const destino = fila
                // La línea, centrada en lo posible dentro de la ventana visible:
                // así se ve también la de encima y la de debajo, y se entiende
                // dónde está dentro del pedido.
                ? fila.offsetTop - (lista.clientHeight - fila.offsetHeight) / 2
                : lista.scrollHeight;

            const tope = Math.max(0, Math.min(destino, lista.scrollHeight - lista.clientHeight));

            // Quien haya pedido menos movimiento en su tablet recibe el salto
            // seco: sigue viendo la línea, sin el recorrido.
            const suave = !window.matchMedia ||
                !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            try {
                lista.scrollTo({ top: tope, behavior: suave ? 'smooth' : 'auto' });
            } catch (err) {
                lista.scrollTop = tope;   // navegadores sin scrollTo
            }

            // Un destello corto en la línea tocada. Con el carrito ya a la vista
            // el desplazamiento no se nota, y sin esto no hay forma de saber
            // cuál de las quince líneas acaba de subir.
            if (fila) {
                fila.classList.remove('tocada');
                // Forzar el reflow reinicia la animación cuando se pulsa el
                // mismo producto dos veces seguidas; sin esto, la segunda no se
                // ve porque la clase nunca llegó a quitarse del todo.
                void fila.offsetWidth;
                fila.classList.add('tocada');
            }
        });
    }

    // Cuántas unidades de un producto hay ya comprometidas en el carrito,
    // sumando las que van sueltas y las que van de acompañante. Un refresco
    // sale de la misma nevera vaya cobrado o de regalo.
    function unidadesEnCarrito(id_producto) {
        return cart.reduce((n, item) => {
            let suma = item.id_producto === id_producto ? item.cantidad : 0;
            // Los acompañantes llevan cantidad POR BOTELLA: dos colas pequeñas
            // en una línea de tres whiskys son seis colas fuera de la nevera.
            (item.acompanantes || []).forEach(a => {
                if (a.id_producto === id_producto) suma += a.cantidad * item.cantidad;
            });
            return n + suma;
        }, 0);
    }

    // La línea del carrito se identifica por el par (producto, acompañante).
    // Dos whiskys, uno con Coca y otro con Sprite, son dos líneas distintas
    // aunque el whisky sea el mismo: si se fundieran, no habría forma de saber
    // cuál lleva cuál al prepararlos.
    // Firma del acompañamiento de una línea, para poder compararlas. Ordenada
    // por id: elegir "2 colas + 1 tónica" y "1 tónica + 2 colas" tiene que dar
    // la misma línea.
    const firmaAcomp = acomps => (acomps || [])
        .slice()
        .sort((a, b) => a.id_producto - b.id_producto)
        .map(a => a.id_producto + 'x' + a.cantidad)
        .join(',');

    const mismaLinea = (item, id_producto, acomps) =>
        item.id_producto === id_producto &&
        firmaAcomp(item.acompanantes) === firmaAcomp(acomps);

    // Cart Lógica
    function addToCart(product, acompanantes) {
        if (unidadesEnCarrito(product.id_producto) >= product.stock_actual) {
            // Dos pulsos, distintos del toque normal: se nota en la mano que
            // eso NO entró, sin tener que leer el aviso.
            vibrar([25, 40, 25]);
            notify('No queda stock de ' + product.nombre + '.', 'warn');
            return;
        }

        // Si la botella lleva acompañamiento, se pregunta ANTES de meterla.
        // Preguntarlo al cobrar sería tarde: el mesero ya se habría ido con el
        // pedido tomado y habría que salir a buscarlo.
        if (product.requiere_acompanante && !acompanantes) {
            abrirCuadroAcompanante(product);
            return;
        }

        const acomps = acompanantes || [];

        // Los acompañantes también salen del almacén: si no queda, no se puede
        // prometer. Mejor enterarse aquí que en la barra.
        for (const a of acomps) {
            const cat = products.find(p => p.id_producto === a.id_producto);
            const disponible = cat ? cat.stock_actual - unidadesEnCarrito(a.id_producto) : 0;
            if (disponible < a.cantidad) {
                vibrar([25, 40, 25]);
                notify('No queda ' + a.nombre + ' para acompañar.', 'warn');
                return;
            }
        }

        const existing = cart.find(item => mismaLinea(item, product.id_producto, acomps));

        if (existing) {
            existing.cantidad++;
            actualizarLinea(existing);
        } else {
            cart.push({
                id_producto: product.id_producto,
                nombre: product.nombre,
                precio_venta: parseFloat(product.precio_venta),
                cantidad: 1,
                stock_max: product.stock_actual,
                acompanantes: acomps
            });
            renderCart();
        }

        recalcularTotal();
        actualizarTarjeta(product.id_producto, true);
        acomps.forEach(a => actualizarTarjeta(a.id_producto, true));
        vibrar(28);
        mostrarLinea(product.id_producto);
    }

    // ==========================================
    // MOVER STOCK A OTRA BARRA
    // ==========================================
    // Tres pasos, uno por pantalla: destino, producto y unidades. De uno en uno
    // porque esto se hace de pie y con prisa: un formulario con cinco campos a
    // la vez se rellena mal y se descubre al día siguiente, cuando falta media
    // caja y nadie sabe a dónde fue.
    //
    // Al confirmar sale la comanda impresa para el bartender que entrega.
    const moverModal = document.getElementById('mover-modal');
    let moverDestino = '';
    let moverProducto = null;
    let moverPendientes = [];      // lo que ya se ha añadido a este movimiento
    let moverDestinosUsados = [];
    // El mismo asistente sirve para las dos direcciones: los tres pasos son los
    // mismos y sólo cambian las palabras y el signo del stock. Duplicarlo sería
    // duplicar también cada arreglo que le haga falta después.
    let moverModo = 'SALIDA';      // 'SALIDA' (se va) | 'ENTRADA' (llega)
    let moverMotivo = 'TRASPASO';  // sólo en ENTRADA: 'COMPRA' | 'TRASPASO'

    const saliendo = () => moverModo === 'SALIDA';

    function abrirMoverStock(modo) {
        moverModo = modo === 'ENTRADA' ? 'ENTRADA' : 'SALIDA';
        moverMotivo = saliendo() ? 'TRASPASO' : 'COMPRA';
        moverDestino = '';
        moverProducto = null;
        moverPendientes = [];
        document.getElementById('mover-destino').value = '';
        document.getElementById('mover-buscar').value = '';
        document.getElementById('mover-nota').value = '';

        // El selector compra/traspaso sólo tiene sentido al agregar.
        document.getElementById('mover-motivos').classList.toggle('hide', saliendo());
        document.querySelectorAll('#mover-motivos .ingreso-tipo').forEach(b =>
            b.classList.toggle('activa', b.dataset.motivo === moverMotivo));

        document.getElementById('mover-confirmar').textContent =
            saliendo() ? 'Confirmar y imprimir' : 'Registrar entrada';

        pintarPendientes();
        cargarDestinosUsados();
        moverPaso(1);
        moverModal.classList.remove('hide');
    }

    function cerrarMoverStock() {
        moverModal.classList.add('hide');
    }

    function moverPaso(n) {
        [1, 2, 3].forEach(i => {
            document.getElementById('mover-p' + i).classList.toggle('hide', i !== n);
            const marca = document.querySelector(`.mover-paso[data-paso="${i}"]`);
            if (marca) {
                marca.classList.toggle('activa', i === n);
                marca.classList.toggle('hecha', i < n);
            }
        });

        const titulo = document.getElementById('mover-titulo');
        const sub = document.getElementById('mover-subtitulo');
        const campo = document.getElementById('mover-destino');

        if (n === 1) {
            if (saliendo()) {
                titulo.textContent = '¿A dónde va?';
                sub.textContent = 'Barra o almacén que la recibe';
                campo.placeholder = 'Ej. Barra VIP';
            } else if (moverMotivo === 'COMPRA') {
                titulo.textContent = '¿A quién se compró?';
                sub.textContent = 'Proveedor que trae la mercancía';
                campo.placeholder = 'Ej. Distribuidora Central';
            } else {
                titulo.textContent = '¿De dónde llega?';
                sub.textContent = 'Barra que manda la mercancía';
                campo.placeholder = 'Ej. Barra VIP';
            }
        } else if (n === 2) {
            titulo.textContent = '¿Qué producto?';
            sub.textContent = (saliendo() ? 'Va a ' : 'Llega de ') + moverDestino;
            pintarProductosMover();
            document.getElementById('mover-buscar').focus();
        } else {
            titulo.textContent = '¿Cuántas unidades?';
            sub.textContent = moverProducto
                ? (saliendo() ? moverProducto.nombre + ' → ' + moverDestino
                              : moverDestino + ' → ' + moverProducto.nombre)
                : '';
        }
    }

    async function cargarDestinosUsados() {
        const caja = document.getElementById('mover-destinos-usados');
        caja.innerHTML = '';
        try {
            const res = await fetch('/api/traspasos');
            const data = await res.json();
            // Sólo destinos de salidas: para mandar mercancía no sirve de nada
            // sugerir el proveedor al que se le compró.
            // Se sugieren los de la misma dirección: para mandar mercancía no
            // sirve de nada ofrecer el proveedor al que se le compró.
            moverDestinosUsados = (data.destinos || [])
                .filter(d => d.tipo === moverModo).map(d => d.contraparte);
        } catch (err) {
            moverDestinosUsados = [];
        }

        // Sugerir los ya usados evita que "Barra VIP", "barra vip" y "VIP"
        // acaben siendo tres destinos distintos que no se pueden sumar.
        moverDestinosUsados.slice(0, 6).forEach(d => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mover-sugerencia';
            b.textContent = d;
            b.addEventListener('click', () => {
                document.getElementById('mover-destino').value = d;
                pasarAProducto();
            });
            caja.appendChild(b);
        });
    }

    function pasarAProducto() {
        const valor = document.getElementById('mover-destino').value.trim();
        if (!valor) {
            notify('Escribe a dónde va la mercancía.', 'warn');
            return;
        }
        moverDestino = valor;
        moverPaso(2);
    }

    function pintarProductosMover() {
        const caja = document.getElementById('mover-productos');
        const filtro = document.getElementById('mover-buscar').value.trim().toLowerCase();
        caja.innerHTML = '';

        // Lo que ya está apartado en este mismo traspaso se descuenta de lo que
        // se ofrece: si no, se podrían mandar 30 de algo de lo que quedan 20.
        const apartado = id => moverPendientes
            .filter(p => p.id_producto === id)
            .reduce((n, p) => n + p.cantidad, 0);

        // Al agregar no se filtra por stock: justamente lo que no queda es lo
        // que se va a reponer, y esconderlo lo haría imposible.
        const lista = products
            .filter(p => !saliendo() || (p.stock_actual - apartado(p.id_producto)) > 0)
            .filter(p => !filtro || p.nombre.toLowerCase().includes(filtro));

        if (!lista.length) {
            const vacio = document.createElement('p');
            vacio.className = 'mover-vacio';
            vacio.textContent = filtro ? 'Ningún producto con ese nombre.' : 'No queda stock que mover.';
            caja.appendChild(vacio);
            return;
        }

        lista.forEach(p => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mover-producto';

            const nombre = document.createElement('span');
            nombre.className = 'mover-producto-nombre';
            nombre.textContent = p.nombre;
            b.appendChild(nombre);

            const stock = document.createElement('span');
            stock.className = 'mover-producto-stock';
            stock.textContent = (p.stock_actual - apartado(p.id_producto)) + ' u.';
            b.appendChild(stock);

            b.addEventListener('click', () => {
                moverProducto = p;
                document.getElementById('mover-elegido').textContent = p.nombre;
                document.getElementById('mover-unidades').value = 1;
                pintarDisponible();
                pintarRapidos();
                moverPaso(3);
            });
            caja.appendChild(b);
        });
    }

    function disponibleDe(p) {
        const apartado = moverPendientes
            .filter(x => x.id_producto === p.id_producto)
            .reduce((n, x) => n + x.cantidad, 0);
        return p.stock_actual - apartado;
    }

    function pintarDisponible() {
        if (!moverProducto) return;
        document.getElementById('mover-disponible').textContent = saliendo()
            ? 'Quedan ' + disponibleDe(moverProducto) + ' en esta barra'
            : 'Ahora hay ' + moverProducto.stock_actual + ' en esta barra';
    }

    // Cantidades de caja: mover mercancía va de seis en seis o de doce en doce,
    // no de una en una. Teclear "24" con el dedo es donde se equivoca.
    function pintarRapidos() {
        const caja = document.getElementById('mover-rapidos');
        caja.innerHTML = '';
        // Al agregar no hay tope: llega la mercancía que llegue.
        const tope = !moverProducto ? 0
            : (saliendo() ? disponibleDe(moverProducto) : Infinity);
        [6, 12, 24].filter(n => n <= tope).forEach(n => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'quick-cash-btn';
            b.textContent = n;
            b.addEventListener('click', () => {
                document.getElementById('mover-unidades').value = n;
                vibrar(20);
            });
            caja.appendChild(b);
        });
        if (saliendo() && tope > 0) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'quick-cash-btn';
            b.textContent = 'Todo (' + tope + ')';
            b.addEventListener('click', () => {
                document.getElementById('mover-unidades').value = tope;
                vibrar(20);
            });
            caja.appendChild(b);
        }
    }

    function pintarPendientes() {
        const caja = document.getElementById('mover-lista');
        caja.innerHTML = '';

        const confirmar = document.getElementById('mover-confirmar');
        if (confirmar) {
            const base = saliendo() ? 'Confirmar y imprimir' : 'Registrar entrada';
            confirmar.textContent = moverPendientes.length
                ? base + ' (' + moverPendientes.length + ')'
                : base;
        }

        if (!moverPendientes.length) return;

        moverPendientes.forEach((p, i) => {
            const fila = document.createElement('div');
            fila.className = 'mover-pendiente';

            const txt = document.createElement('span');
            txt.textContent = p.cantidad + ' × ' + p.nombre;
            fila.appendChild(txt);

            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'mover-quitar';
            quitar.textContent = '✕';
            quitar.setAttribute('aria-label', 'Quitar ' + p.nombre);
            quitar.addEventListener('click', () => {
                moverPendientes.splice(i, 1);
                pintarPendientes();
                pintarDisponible();
            });
            fila.appendChild(quitar);

            caja.appendChild(fila);
        });
    }

    function apuntarLoElegido() {
        if (!moverProducto) return false;
        const n = parseInt(document.getElementById('mover-unidades').value, 10);
        if (!Number.isInteger(n) || n <= 0) {
            notify('Pon cuántas unidades vas a mover.', 'warn');
            return false;
        }
        if (saliendo() && n > disponibleDe(moverProducto)) {
            notify('Sólo quedan ' + disponibleDe(moverProducto) + ' de ' + moverProducto.nombre + '.', 'warn');
            return false;
        }
        moverPendientes.push({
            id_producto: moverProducto.id_producto,
            nombre: moverProducto.nombre,
            cantidad: n
        });
        pintarPendientes();
        return true;
    }

    async function confirmarTraspaso() {
        if (!apuntarLoElegido()) return;

        const boton = document.getElementById('mover-confirmar');
        boton.disabled = true;
        try {
            const res = await fetch('/api/traspaso', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tipo: moverModo,
                    motivo: saliendo() ? 'TRASPASO' : moverMotivo,
                    contraparte: moverDestino,
                    observaciones: document.getElementById('mover-nota').value.trim(),
                    id_cajero: currentUser ? currentUser.id_cajero : null,
                    items: moverPendientes.map(p => ({ id_producto: p.id_producto, cantidad: p.cantidad }))
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo registrar el traspaso.', 'error', 7000);
                return;
            }

            cerrarMoverStock();
            notify(data.message, 'ok', 6000);
            vibrar([30, 60, 30]);
            // El stock de la caja tiene que reflejar de inmediato lo que se fue,
            // o el cajero seguiría vendiendo lo que ya está en la otra barra.
            await fetchProductsAndMenu();
            // La comanda se imprime en las dos direcciones: al mandar sirve de
            // entrega, y al recibir de acuse. En los dos casos alguien tiene
            // que poder demostrar que la mercancía cambió de manos.
            imprimirTraspaso(data);
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    // La comanda del traspaso: la misma vista previa y la misma impresora que
    // los tickets de venta, para que el bartender vea siempre el mismo papel.
    function imprimirTraspaso(data) {
        const ahora = new Date();
        const dos = n => String(n).padStart(2, '0');
        const modelo = {
            id: data.id_traspaso,
            tipo: data.tipo,
            motivo: data.motivo,
            barra: configEvento.barra || instancia.nombre || 'Barra',
            contraparte: data.contraparte,
            fecha: dos(ahora.getDate()) + '/' + dos(ahora.getMonth() + 1) + '/' + ahora.getFullYear(),
            hora: dos(ahora.getHours()) + ':' + dos(ahora.getMinutes()),
            responsable: currentUser ? currentUser.nombre : '',
            observaciones: data.observaciones || '',
            items: data.items || []
        };

        const ajustes = ThermalPrinter.getSettings();
        const ops = ThermalPrinter.buildTraspasoOps(modelo, ajustes);

        traspasoParaImprimir = { ops: ops, modelo: modelo };
        document.getElementById('traspaso-body').innerHTML =
            ThermalPrinter.helpers.opsToHtml(ops, ajustes);
        document.getElementById('traspaso-modal').classList.remove('hide');
    }

    let traspasoParaImprimir = null;

    document.getElementById('mover-stock-btn')
        .addEventListener('click', () => abrirMoverStock('SALIDA'));
    document.getElementById('agregar-stock-btn')
        .addEventListener('click', () => abrirMoverStock('ENTRADA'));

    document.querySelectorAll('#mover-motivos .ingreso-tipo').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#mover-motivos .ingreso-tipo')
                .forEach(b => b.classList.remove('activa'));
            btn.classList.add('activa');
            moverMotivo = btn.dataset.motivo;
            // El rótulo cambia con el motivo: no se pregunta igual por un
            // proveedor que por la barra de al lado.
            moverPaso(1);
            cargarDestinosUsados();
        });
    });
    document.getElementById('mover-cerrar').addEventListener('click', cerrarMoverStock);
    moverModal.addEventListener('click', e => {
        if (e.target === moverModal) cerrarMoverStock();
    });
    document.getElementById('mover-a-producto').addEventListener('click', pasarAProducto);
    document.getElementById('mover-destino').addEventListener('keydown', e => {
        if (e.key === 'Enter') pasarAProducto();
    });
    document.getElementById('mover-buscar').addEventListener('input', pintarProductosMover);
    document.getElementById('mover-menos').addEventListener('click', () => {
        const campo = document.getElementById('mover-unidades');
        campo.value = Math.max(1, (parseInt(campo.value, 10) || 1) - 1);
        vibrar(20);
    });
    document.getElementById('mover-mas').addEventListener('click', () => {
        const campo = document.getElementById('mover-unidades');
        const tope = moverProducto ? disponibleDe(moverProducto) : 1;
        campo.value = Math.min(tope, (parseInt(campo.value, 10) || 0) + 1);
        vibrar(20);
    });
    document.getElementById('mover-otro').addEventListener('click', () => {
        if (!apuntarLoElegido()) return;
        moverProducto = null;
        document.getElementById('mover-buscar').value = '';
        moverPaso(2);
    });
    document.getElementById('mover-confirmar').addEventListener('click', confirmarTraspaso);

    document.getElementById('traspaso-cerrar').addEventListener('click', () => {
        document.getElementById('traspaso-modal').classList.add('hide');
        traspasoParaImprimir = null;
    });

    document.getElementById('traspaso-imprimir').addEventListener('click', () => {
        if (!traspasoParaImprimir) return;
        try {
            ThermalPrinter.printOps(traspasoParaImprimir.ops);
            notify('Enviado a la impresora.', 'ok');
        } catch (err) {
            notify('No se pudo imprimir: ' + (err.message || 'revisa RawBT'), 'error');
        }
    });

    // ==========================================
    // CUADRO DE ACOMPAÑANTE
    // ==========================================
    const acompModal = document.getElementById('acomp-modal');
    let productoEsperandoAcompanante = null;

    // Lo elegido en el cuadro: { id_producto -> cantidad por botella }.
    let acompElegidos = new Map();

    function abrirCuadroAcompanante(product) {
        productoEsperandoAcompanante = product;
        acompElegidos = new Map();
        document.getElementById('acomp-producto').textContent = product.nombre;

        pintarOpcionesAcompanante();
        acompModal.classList.remove('hide');
    }

    function pintarOpcionesAcompanante() {
        const caja = document.getElementById('acomp-opciones');
        const vacio = document.getElementById('acomp-vacio');
        caja.innerHTML = '';

        // TODOS los marcados como acompañante, agotados incluidos.
        //
        // Antes se escondían los que no tenían stock, y eso dejaba al cajero
        // buscando una Coca-Cola que sí existe pero se acabó, sin entender por
        // qué no aparece. Sale, marcada como agotada y sin poder tocarse: se ve
        // que se acabó y se elige otra cosa.
        const opciones = products.filter(p => p.es_acompanante);
        vacio.classList.toggle('hide', opciones.length > 0);

        opciones.forEach(p => {
            const disponible = p.stock_actual - unidadesEnCarrito(p.id_producto);
            const puestas = acompElegidos.get(p.id_producto) || 0;
            const agotado = disponible <= 0;

            const fila = document.createElement('div');
            fila.className = 'acomp-opcion' + (agotado ? ' agotada' : '') +
                (puestas > 0 ? ' elegida' : '');

            const texto = document.createElement('div');
            texto.className = 'acomp-opcion-texto';

            const nombre = document.createElement('span');
            nombre.className = 'acomp-opcion-nombre';
            nombre.textContent = p.nombre;
            texto.appendChild(nombre);

            const stock = document.createElement('span');
            stock.className = 'acomp-opcion-stock' + (agotado ? ' agotado' : '');
            stock.textContent = agotado ? 'Agotado' : 'quedan ' + disponible;
            texto.appendChild(stock);

            fila.appendChild(texto);

            if (agotado) {
                caja.appendChild(fila);
                return;
            }

            // Cantidad por botella: si se acabó la Coca de dos litros, se ponen
            // dos pequeñas y el cliente se lleva lo mismo.
            const control = document.createElement('div');
            control.className = 'acomp-control';

            const menos = document.createElement('button');
            menos.type = 'button';
            menos.className = 'cart-qty-btn';
            menos.textContent = '−';
            menos.setAttribute('aria-label', 'Una menos de ' + p.nombre);
            menos.disabled = puestas === 0;
            menos.addEventListener('click', () => cambiarAcomp(p, -1));
            control.appendChild(menos);

            const num = document.createElement('span');
            num.className = 'acomp-cantidad';
            num.textContent = puestas;
            control.appendChild(num);

            const mas = document.createElement('button');
            mas.type = 'button';
            mas.className = 'cart-qty-btn';
            mas.textContent = '+';
            mas.setAttribute('aria-label', 'Uno más de ' + p.nombre);
            mas.disabled = puestas >= disponible;
            mas.addEventListener('click', () => cambiarAcomp(p, +1));
            control.appendChild(mas);

            fila.appendChild(control);

            // Tocar la fila entera suma uno: con prisa, apuntar al "+" de 44 px
            // es más difícil que tocar el bloque.
            texto.addEventListener('click', () => cambiarAcomp(p, +1));

            caja.appendChild(fila);
        });

        pintarResumenAcompanante();
    }

    function cambiarAcomp(p, delta) {
        const disponible = p.stock_actual - unidadesEnCarrito(p.id_producto);
        const ahora = acompElegidos.get(p.id_producto) || 0;
        const nuevo = Math.max(0, Math.min(disponible, ahora + delta));
        if (nuevo === ahora) {
            if (delta > 0) {
                vibrar([25, 40, 25]);
                notify('No queda más ' + p.nombre + '.', 'warn');
            }
            return;
        }
        if (nuevo === 0) acompElegidos.delete(p.id_producto);
        else acompElegidos.set(p.id_producto, nuevo);
        vibrar(20);
        pintarOpcionesAcompanante();
    }

    function pintarResumenAcompanante() {
        const resumen = document.getElementById('acomp-resumen');
        const aceptar = document.getElementById('acomp-aceptar');
        if (!resumen || !aceptar) return;

        if (acompElegidos.size === 0) {
            resumen.textContent = 'Elige el acompañamiento';
            resumen.classList.remove('tiene');
            aceptar.disabled = true;
            return;
        }

        const partes = [];
        acompElegidos.forEach((cant, id) => {
            const p = products.find(x => x.id_producto === id);
            partes.push(cant + ' × ' + (p ? p.nombre : 'producto'));
        });
        resumen.textContent = partes.join('  ·  ');
        resumen.classList.add('tiene');
        aceptar.disabled = false;
    }

    function cerrarCuadroAcompanante() {
        acompModal.classList.add('hide');
        productoEsperandoAcompanante = null;
    }

    document.getElementById('acomp-aceptar').addEventListener('click', () => {
        if (!productoEsperandoAcompanante || acompElegidos.size === 0) return;
        const elegidos = [];
        acompElegidos.forEach((cantidad, id) => {
            const p = products.find(x => x.id_producto === id);
            elegidos.push({ id_producto: id, nombre: p ? p.nombre : 'Producto', cantidad });
        });
        const botella = productoEsperandoAcompanante;
        cerrarCuadroAcompanante();
        addToCart(botella, elegidos);
    });

    document.getElementById('acomp-cancelar').addEventListener('click', cerrarCuadroAcompanante);
    // Tocar fuera cancela: es lo que todo el mundo intenta primero, y aquí no
    // se pierde nada porque el producto todavía no entró en el carrito.
    acompModal.addEventListener('click', e => {
        if (e.target === acompModal) cerrarCuadroAcompanante();
    });

    // Suma del carrito. Vive aparte porque ahora se recalcula sin repintar nada.
    function recalcularTotal() {
        const total = cart.reduce((s, item) => s + item.precio_venta * item.cantidad, 0);
        const casilla = document.getElementById('cart-total-amount');
        const texto = `${total.toFixed(2)} Bs.`;

        // Un latido cuando la cifra cambia de verdad. El total es lo único de
        // la pantalla que el cajero dice en voz alta, y con el dedo encima de
        // la rejilla no siempre mira al carrito: el movimiento se ve de reojo
        // y confirma que el toque entró. Si no cambia no se mueve, para que no
        // se vuelva un tic que se deja de mirar.
        if (casilla.textContent !== texto) {
            casilla.textContent = texto;
            casilla.classList.remove('total-late');
            void casilla.offsetWidth;   // reinicia la animación
            casilla.classList.add('total-late');
        }

        const contador = document.getElementById('cart-count');
        contador.textContent = cart.length;
        contador.classList.toggle('tiene', cart.length > 0);

        updatePaymentDetails(total);
        return total;
    }

    // Una fila se identifica por el par producto+acompañante, no sólo por el
    // producto: puede haber dos whiskys en el carrito con refrescos distintos.
    const claveLinea = item => item.id_producto + '|' + firmaAcomp(item.acompanantes);

    function filaDe(item) {
        return document.querySelector(
            `.cart-item[data-clave="${claveLinea(item)}"]`);
    }

    // Cambia sólo los números de una línea ya pintada, sin tocar el resto del
    // carrito: subir una cantidad no debe hacer parpadear toda la lista.
    function actualizarLinea(item) {
        const fila = filaDe(item);
        if (!fila) return renderCart();

        const sub = item.precio_venta * item.cantidad;
        fila.querySelector('.price').textContent =
            `${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.`;
        fila.querySelector('.qty').textContent = item.cantidad;
        // Las cantidades de los acompañantes van con la de la línea.
        fila.querySelectorAll('.cart-acomp-cant').forEach((el, i) => {
            const a = (item.acompanantes || [])[i];
            if (a) el.textContent = a.cantidad * item.cantidad;
        });
    }

    function quitarDelCarrito(item) {
        const acomps = item.acompanantes || [];
        cart = cart.filter(c => !mismaLinea(c, item.id_producto, acomps));
        renderCart();
        recalcularTotal();
        actualizarTarjeta(item.id_producto);
        acomps.forEach(a => actualizarTarjeta(a.id_producto));
    }

    function renderCart() {
        const container = document.getElementById('cart-items');
        // Las líneas que ya estaban no vuelven a animarse; sólo entra la nueva.
        const yaPintadas = new Set(
            [...container.querySelectorAll('.cart-item')].map(el => el.dataset.clave)
        );
        container.innerHTML = '';

        if (cart.length === 0) {
            container.innerHTML = `<div class="empty-cart-msg">El carrito está vacío</div>`;
            recalcularTotal();
            return;
        }

        cart.forEach(item => {
            const sub = item.precio_venta * item.cantidad;
            const clave = claveLinea(item);

            const div = document.createElement('div');
            div.className = 'cart-item' + (yaPintadas.has(clave) ? '' : ' enter');
            div.dataset.id = item.id_producto;
            div.dataset.clave = clave;

            // El acompañante va debajo y sangrado, sin importe: se lee de un
            // vistazo que va dentro de la botella y no que se cobra aparte.
            // Todos los acompañantes, cada uno con su cantidad ya multiplicada
            // por las botellas de la línea: es lo que hay que servir.
            const acompHtml = (item.acompanantes || []).map(a => `
                   <div class="cart-acomp">
                       <span class="cart-acomp-flecha" aria-hidden="true">↳</span>
                       <span class="cart-acomp-nombre">${escapeHtml(a.nombre)}</span>
                       <span class="cart-acomp-cant">${a.cantidad * item.cantidad}</span>
                       <span class="cart-acomp-gratis">incluido</span>
                   </div>`).join('');

            div.innerHTML = `
                <div class="cart-item-info">
                    <h4>${escapeHtml(item.nombre)}</h4>
                    <div class="price">${item.precio_venta.toFixed(2)} x ${item.cantidad} = ${sub.toFixed(2)} Bs.</div>
                    ${acompHtml}
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
                    (item.acompanantes || []).forEach(a => actualizarTarjeta(a.id_producto, true));
                } else {
                    quitarDelCarrito(item);
                }
            });

            div.querySelector('.increase-btn').addEventListener('click', () => {
                // Se consulta el stock vivo, no el que había al añadirlo: otra
                // tablet puede haber vendido unidades desde entonces.
                const enCatalogo = products.find(p => p.id_producto === item.id_producto);
                const tope = enCatalogo ? enCatalogo.stock_actual : item.stock_max;
                // unidadesEnCarrito y no item.cantidad: el mismo producto puede
                // estar además de acompañante en otra línea, y todo sale del
                // mismo almacén.
                if (unidadesEnCarrito(item.id_producto) >= tope) {
                    notify('No queda stock de ' + item.nombre + '.', 'warn');
                    return;
                }
                // Una botella más se lleva sus acompañantes: hay que
                // comprobar que quedan todos antes de subir la cantidad.
                for (const a of (item.acompanantes || [])) {
                    const cat = products.find(p => p.id_producto === a.id_producto);
                    const tope = cat ? cat.stock_actual : 0;
                    if (unidadesEnCarrito(a.id_producto) + a.cantidad > tope) {
                        notify('No queda ' + a.nombre + ' para acompañar.', 'warn');
                        return;
                    }
                }
                item.cantidad++;
                actualizarLinea(item);
                recalcularTotal();
                actualizarTarjeta(item.id_producto, true);
                (item.acompanantes || []).forEach(a => actualizarTarjeta(a.id_producto, true));
                // El "+" también es "poner en el carrito": mismo golpecito, o
                // el cajero no sabe cuál de sus toques contó.
                vibrar(28);
            });

            div.querySelector('.remove-item-btn').addEventListener('click', () => {
                vibrar([18, 30, 18]);
                quitarDelCarrito(item);
            });

            container.appendChild(div);
        });

        recalcularTotal();
    }

    document.getElementById('clear-cart').addEventListener('click', () => {
        // Antes vaciaba la lista pero dejaba el contador y el total con las
        // cifras anteriores: la pantalla decía "3" y "58.00 Bs." sobre un
        // carrito vacío. Ahora usa el mismo vaciado que salir sin cobrar.
        if (!cart.length) return;
        vibrar([20, 30, 20]);
        vaciarCarrito();
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
                subtotal: c.precio_venta * c.cantidad,
                // Sólo el id: el precio del acompañante lo pone el servidor, y
                // es cero. Si viajara desde aquí, bastaría con retocar la
                // petición para regalarse una botella.
                // Cantidades POR BOTELLA: el servidor las multiplica por las
                // unidades de la línea. Sólo viajan ids y cantidades; el precio
                // (cero) lo pone él.
                acompanantes: (c.acompanantes || []).map(a => ({
                    id_producto: a.id_producto, cantidad: a.cantidad
                }))
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
                    anotarEnElTurno(typeof result.total === 'number' ? result.total : bodyData.total);
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
            ref: data.ref_comanda || refComanda(id_comanda),
            instancia: data.instancia || instancia.nombre,
            fecha: ddmmaaaa + ' ' + hhmm,
            // Separadas además de juntas: el ticket las coloca en las dos
            // puntas de la misma línea, y el de barra sólo usa la hora.
            fechaDia: ddmmaaaa,
            hora: hhmm,
            // El nombre del evento encabeza el ticket. Sale de Datos del
            // evento, igual que la barra.
            evento: configEvento.evento || '',
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
                    subtotal: Number(item.subtotal) || 0,
                    // El acompañante viaja DENTRO de su línea, no como línea
                    // aparte: el ticket lo imprime sangrado debajo y sin
                    // importe, que es como se entiende que va incluido.
                    acompanantes: item.acompanantes
                        ? item.acompanantes.map(a => ({ nombre: a.nombre, cantidad: a.cantidad }))
                        : (item.acomps || []).map(a => ({ nombre: a.nombre, cantidad: a.qty }))
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
            fechaDia: new Date().toLocaleDateString(),
            hora: new Date().toTimeString().slice(0, 5),
            evento: configEvento.evento || '',
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
            vaciarCarrito();
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
            else if (targetTab === 'tab-crear-producto') { loadCatalogSetup(); cargarCatalogoAdmin(); }
            else if (targetTab === 'tab-crear-personal') { loadPersonalSetup(); cargarPersonalAdmin(); }
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
            // etiqueta de la pantalla, el título de la pestaña y lo que se
            // imprime, así que se recargan sin reiniciar nada.
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
            notify('Datos del evento guardados.', 'ok');
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
                    foto: fotoNuevoProducto,
                    requiere_acompanante: document.getElementById('prod-requiere').checked,
                    es_acompanante: document.getElementById('prod-es-acomp').checked,
                    id_categoria, nombre, descripcion, tipo_producto, precio_venta, stock_actual,
                    id_admin: currentUser.id_admin, id_evento: currentUser.id_evento
                })
            });
            const data = await response.json();

            if (data.success) {
                notify('Producto creado.', 'ok');
                document.getElementById('form-create-product').reset();
                // reset() no vacía la vista previa de la foto: es un <div>, no
                // un campo del formulario.
                limpiarFotoDelFormulario();
                // reset() sí desmarca las casillas, pero se dejan explícitas
                // porque el alta siguiente no debe heredar nada de la anterior.
                document.getElementById('prod-requiere').checked = false;
                document.getElementById('prod-es-acomp').checked = false;
                cargarCatalogoAdmin();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // ==========================================
    // FOTOS DE PRODUCTO
    // ==========================================
    // La foto se reduce aquí, en la tablet, antes de salir por la red.
    //
    // Una foto de la cámara son 3-8 MB. Sin reducir habría que subirlos por el
    // WiFi del hotspot, guardarlos en el .db y volver a bajarlos en cada tablet
    // cliente al abrir la caja: la rejilla de productos tardaría segundos en
    // pintarse. Reducida a 400 px de lado pesa unos 30 KB y se ve perfecta en
    // una tarjeta que mide 150.
    const FOTO_LADO = 400;
    const FOTO_CALIDAD = 0.82;
    // El mismo tope que aplica el servidor, con holgura: más vale recortar
    // aquí, donde todavía se puede cambiar de formato, que recibir un rechazo
    // cuando ya no queda nada que hacer.
    const FOTO_MAX_CARACTERES = Math.floor(400 * 1024 * 1.4 * 0.9);

    /**
     * ¿La imagen tiene algún píxel transparente?
     *
     * No se miran los cuatro millones de píxeles: basta el borde, que es donde
     * está el fondo de un recorte de producto. Se recorre el marco de fuera y
     * en cuanto aparece un píxel no opaco se para.
     */
    function tieneTransparencia(ctx, ancho, alto) {
        try {
            const puntos = [];
            const paso = Math.max(1, Math.floor(Math.min(ancho, alto) / 24));
            for (let x = 0; x < ancho; x += paso) puntos.push([x, 0], [x, alto - 1]);
            for (let y = 0; y < alto; y += paso) puntos.push([0, y], [ancho - 1, y]);
            for (const [x, y] of puntos) {
                if (ctx.getImageData(x, y, 1, 1).data[3] < 250) return true;
            }
        } catch (err) {
            // Un lienzo "sucio" no deja leerse. Ante la duda, JPEG con blanco:
            // pesa menos y nunca sale con el fondo negro.
            return false;
        }
        return false;
    }

    function reducirImagen(archivo) {
        return new Promise((resolve, reject) => {
            const lector = new FileReader();
            lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            lector.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('Ese archivo no es una imagen.'));
                img.onload = () => {
                    // Nunca se agranda: una foto pequeña se queda como está en
                    // vez de estirarse y verse borrosa.
                    const escala = Math.min(1, FOTO_LADO / Math.max(img.width, img.height));
                    const ancho = Math.max(1, Math.round(img.width * escala));
                    const alto = Math.max(1, Math.round(img.height * escala));

                    const lienzo = document.createElement('canvas');
                    lienzo.width = ancho;
                    lienzo.height = alto;
                    const ctx = lienzo.getContext('2d');
                    ctx.drawImage(img, 0, 0, ancho, alto);

                    // Si la foto trae fondo transparente se guarda en PNG y la
                    // botella queda recortada sobre el fondo oscuro de la
                    // tarjeta, que es como mejor se ve. Si es una foto normal
                    // se pasa a JPEG, que pesa la cuarta parte; en ese caso hay
                    // que pintar el blanco por debajo, porque un JPEG no tiene
                    // transparencia y lo que no se rellena sale negro.
                    try {
                        if (tieneTransparencia(ctx, ancho, alto)) {
                            const enPng = lienzo.toDataURL('image/png');
                            // El PNG no comprime como el JPEG. Una foto con
                            // mucho detalle puede pasarse del tamaño que acepta
                            // la base, y el aviso que le llegaría a quien la
                            // sube ("pesa demasiado") no dice qué hacer con
                            // ella. Si se pasa, se cambia a JPEG y se pierde el
                            // fondo recortado, que es mucho menos grave que no
                            // poder poner la foto.
                            if (enPng.length <= FOTO_MAX_CARACTERES) {
                                resolve(enPng);
                                return;
                            }
                        }
                        ctx.globalCompositeOperation = 'destination-over';
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, ancho, alto);
                        resolve(lienzo.toDataURL('image/jpeg', FOTO_CALIDAD));
                    } catch (err) {
                        reject(new Error('No se pudo procesar la imagen.'));
                    }
                };
                img.src = lector.result;
            };
            lector.readAsDataURL(archivo);
        });
    }

    // Pinta una foto (o el hueco de "sin foto") dentro de un contenedor.
    function pintarFoto(caja, dataUri) {
        if (!caja) return;
        caja.innerHTML = '';
        if (dataUri) {
            const img = document.createElement('img');
            img.src = dataUri;
            img.alt = '';
            caja.appendChild(img);
            caja.classList.add('tiene');
        } else {
            const vacio = document.createElement('span');
            vacio.className = 'foto-vacia';
            vacio.textContent = 'Sin foto';
            caja.appendChild(vacio);
            caja.classList.remove('tiene');
        }
    }

    // ---- Foto en el formulario de alta --------------------------------------
    let fotoNuevoProducto = null;

    const fotoInput = document.getElementById('prod-foto');
    const fotoVista = document.getElementById('prod-foto-vista');
    const fotoQuitar = document.getElementById('prod-foto-quitar');

    if (fotoInput) {
        fotoInput.addEventListener('change', async e => {
            const archivo = e.target.files && e.target.files[0];
            if (!archivo) return;
            try {
                fotoNuevoProducto = await reducirImagen(archivo);
                pintarFoto(fotoVista, fotoNuevoProducto);
                fotoQuitar.classList.remove('hide');
            } catch (err) {
                notify(err.message || 'No se pudo usar esa imagen.', 'error');
                fotoInput.value = '';
            }
        });

        fotoQuitar.addEventListener('click', () => {
            fotoNuevoProducto = null;
            fotoInput.value = '';
            pintarFoto(fotoVista, null);
            fotoQuitar.classList.add('hide');
        });
    }

    function limpiarFotoDelFormulario() {
        fotoNuevoProducto = null;
        if (fotoInput) fotoInput.value = '';
        pintarFoto(fotoVista, null);
        if (fotoQuitar) fotoQuitar.classList.add('hide');
    }

    // ---- Cambiar la foto de un producto que ya existe -----------------------
    // Un único control de archivo escondido que se reutiliza: crear uno por
    // fila dejaría veinte en la página sin ninguna ventaja.
    const fotoSuelta = document.createElement('input');
    fotoSuelta.type = 'file';
    fotoSuelta.accept = 'image/png,image/jpeg,image/webp';
    fotoSuelta.className = 'foto-input';
    document.body.appendChild(fotoSuelta);
    let productoDeLaFoto = null;

    fotoSuelta.addEventListener('change', async e => {
        const archivo = e.target.files && e.target.files[0];
        if (!archivo || !productoDeLaFoto) return;
        try {
            const dataUri = await reducirImagen(archivo);
            await guardarFotoProducto(productoDeLaFoto, dataUri);
        } catch (err) {
            notify(err.message || 'No se pudo usar esa imagen.', 'error');
        } finally {
            fotoSuelta.value = '';
            productoDeLaFoto = null;
        }
    });

    function pedirFotoPara(id_producto) {
        productoDeLaFoto = id_producto;
        fotoSuelta.click();
    }

    async function guardarFotoProducto(id_producto, dataUri) {
        try {
            const res = await fetch('/api/admin/productos/' + id_producto + '/foto', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ foto: dataUri })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar la foto.', 'error');
                return;
            }
            notify(data.message, 'ok');
            cargarCatalogoAdmin();
            // La caja tiene que enterarse: si no, el cajero sigue viendo el
            // dibujito hasta que recargue la página.
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // ==========================================
    // LISTAS DEL PANEL: VER Y ELIMINAR
    // ==========================================
    // El panel sólo dejaba crear. No había forma de ver qué había ya, ni de
    // quitar lo que sobraba, así que el catálogo de ejemplo se quedaba mezclado
    // con los productos de verdad y en la caja aparecían cosas que no se venden.
    //
    // Eliminar no siempre borra: lo que ya tiene ventas se retira (deja de salir
    // en la caja) pero se conserva, porque el cierre de caja lo nombra. El
    // servidor decide cuál de los dos casos es y lo dice en su respuesta.

    // Pregunta antes de borrar. Es el único sitio de la aplicación donde se
    // pierde algo de forma irreversible, así que se pide confirmación aunque
    // sea un toque más.
    function confirmarBorrado(texto) {
        return window.confirm(texto);
    }

    async function borrar(url, texto, alTerminar) {
        if (!confirmarBorrado(texto)) return;
        try {
            const res = await fetch(url, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_admin: currentUser ? currentUser.id_admin : 1 })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo eliminar.', 'error', 7000);
                return;
            }
            // Los retirados llevan más explicación que un simple "hecho": el
            // encargado tiene que entender por qué sigue existiendo.
            notify(data.message, data.retirado ? 'warn' : 'ok', data.retirado ? 8000 : 4000);
            if (alTerminar) alTerminar();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // Una fila de lista.
    //
    // Va en DOS renglones y no en uno: el nombre arriba, ocupando todo el
    // ancho, y debajo los datos y las marcas.
    //
    // En una sola línea, las tres insignias ("vendido 1×", "con acompañante",
    // "es acompañante") más la foto y los botones se comían el sitio y el
    // nombre quedaba en "Ballant…" y "Chivas …": dos whiskys distintos que se
    // leían igual. El nombre es lo que se busca en esta lista, así que es lo
    // único que tiene garantizada la línea entera.
    function filaLista({ titulo, detalle, insignia, inactivo, onBorrar,
                         foto, onFoto, onQuitarFoto, marcas, onEditar }) {
        const fila = document.createElement('div');
        fila.className = 'lista-fila' + (inactivo ? ' inactiva' : '');

        // Miniatura, sólo en las filas que pueden tenerla. Es un botón: se toca
        // la foto para ponerla o cambiarla.
        if (onFoto) {
            const btnFoto = document.createElement('button');
            btnFoto.type = 'button';
            btnFoto.className = 'lista-foto' + (foto ? ' tiene' : '');
            btnFoto.title = foto ? 'Cambiar la foto' : 'Añadir una foto';
            btnFoto.setAttribute('aria-label', (foto ? 'Cambiar' : 'Añadir') + ' foto de ' + titulo);
            if (foto) {
                const img = document.createElement('img');
                img.src = foto;
                img.alt = '';
                // Descarga diferida: con veinte fotos en la lista, cargarlas
                // todas de golpe retrasa el primer pintado de la pestaña.
                img.loading = 'lazy';
                btnFoto.appendChild(img);
            } else {
                btnFoto.textContent = '+';
            }
            btnFoto.addEventListener('click', onFoto);
            fila.appendChild(btnFoto);
        }

        const cuerpo = document.createElement('div');
        cuerpo.className = 'lista-cuerpo';

        // Renglón 1: el nombre, solo, con todo el ancho.
        const nombre = document.createElement('span');
        nombre.className = 'lista-nombre';
        nombre.textContent = titulo;
        cuerpo.appendChild(nombre);

        // Renglón 2: datos, insignias y marcas. Si no caben, saltan de línea
        // en vez de empujar al nombre.
        const meta = document.createElement('div');
        meta.className = 'lista-meta';

        if (detalle) {
            const sub = document.createElement('span');
            sub.className = 'lista-detalle';
            sub.textContent = detalle;
            meta.appendChild(sub);
        }

        if (insignia) {
            const ins = document.createElement('span');
            ins.className = 'lista-insignia';
            ins.textContent = insignia;
            meta.appendChild(ins);
        }

        if (inactivo) {
            const ret = document.createElement('span');
            ret.className = 'lista-insignia retirada';
            ret.textContent = 'Retirado';
            meta.appendChild(ret);
        }

        // Marcas alternables (acompañamiento). Se pintan siempre, encendidas o
        // apagadas: si sólo salieran las activas, no habría dónde tocar para
        // encender la primera.
        if (marcas && !inactivo) {
            marcas.forEach(m => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'lista-marca' + (m.activa ? ' activa' : '');
                b.textContent = m.texto;
                b.title = (m.activa ? 'Quitar: ' : 'Marcar: ') + m.texto;
                b.setAttribute('aria-pressed', m.activa ? 'true' : 'false');
                b.addEventListener('click', m.onTocar);
                meta.appendChild(b);
            });
        }

        if (meta.childNodes.length) cuerpo.appendChild(meta);
        fila.appendChild(cuerpo);

        // Acciones, siempre a la derecha y siempre en el mismo sitio.
        const acciones = document.createElement('div');
        acciones.className = 'lista-acciones';

        if (onEditar && !inactivo) {
            const ed = document.createElement('button');
            ed.type = 'button';
            ed.className = 'lista-editar';
            ed.title = 'Editar';
            ed.setAttribute('aria-label', 'Editar ' + titulo);
            ed.textContent = '✎';
            ed.addEventListener('click', onEditar);
            acciones.appendChild(ed);
        }

        if (onQuitarFoto && !inactivo) {
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'lista-quitar-foto';
            quitar.title = 'Quitar la foto';
            quitar.setAttribute('aria-label', 'Quitar la foto de ' + titulo);
            quitar.textContent = '🚫';
            quitar.addEventListener('click', onQuitarFoto);
            acciones.appendChild(quitar);
        }

        if (!inactivo) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lista-borrar';
            btn.title = 'Eliminar';
            btn.setAttribute('aria-label', 'Eliminar ' + titulo);
            btn.textContent = '✕';
            btn.addEventListener('click', onBorrar);
            acciones.appendChild(btn);
        }

        fila.appendChild(acciones);
        return fila;
    }

    // Cabecera de grupo. Una lista de cuarenta y cinco meseros seguidos no se
    // puede repasar; agrupada por cajero, cada bloque es del tamaño de lo que
    // una persona lleva a su cargo, que es como se reparte el trabajo.
    function cabeceraGrupo(texto, cuantos) {
        const h = document.createElement('div');
        h.className = 'lista-grupo';
        const a = document.createElement('span');
        a.className = 'lista-grupo-nombre';
        a.textContent = texto;
        h.appendChild(a);
        const b = document.createElement('span');
        b.className = 'lista-grupo-cuenta';
        b.textContent = cuantos;
        h.appendChild(b);
        return h;
    }

    // Agrupa conservando el orden de aparición: así el orden de los grupos no
    // baila entre un repintado y el siguiente.
    function agrupar(lista, claveDe) {
        const grupos = new Map();
        lista.forEach(x => {
            const k = claveDe(x) || 'Sin asignar';
            if (!grupos.has(k)) grupos.set(k, []);
            grupos.get(k).push(x);
        });
        return grupos;
    }

    function pintarVacio(contenedor, texto) {
        contenedor.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'lista-vacia';
        p.textContent = texto;
        contenedor.appendChild(p);
    }

    // ---- Catálogo -----------------------------------------------------------
    let catalogoAdmin = { categorias: [], productos: [] };

    async function cargarCatalogoAdmin() {
        try {
            const res = await fetch('/api/admin/catalogo');
            catalogoAdmin = await res.json();
        } catch (err) {
            catalogoAdmin = { categorias: [], productos: [] };
        }
        pintarCategorias();
        pintarProductosAdmin();
    }

    function pintarCategorias() {
        const cont = document.getElementById('lista-categorias');
        if (!cont) return;
        const cats = catalogoAdmin.categorias || [];
        document.getElementById('cont-categorias').textContent = cats.length;

        if (!cats.length) return pintarVacio(cont, 'Todavía no hay categorías.');

        cont.innerHTML = '';
        cats.forEach(c => {
            cont.appendChild(filaLista({
                titulo: c.nombre,
                detalle: c.descripcion || '',
                insignia: c.productos + (c.productos === 1 ? ' producto' : ' productos'),
                inactivo: c.activo === 0,
                onBorrar: () => borrar(
                    '/api/admin/categorias/' + c.id_categoria,
                    '¿Eliminar la categoría "' + c.nombre + '"?',
                    () => { cargarCatalogoAdmin(); loadCatalogSetup(); })
            }));
        });
    }

    function pintarProductosAdmin() {
        const cont = document.getElementById('lista-productos');
        if (!cont) return;
        const filtro = (document.getElementById('buscar-producto-cat').value || '')
            .trim().toLowerCase();
        const todos = catalogoAdmin.productos || [];
        const lista = filtro
            ? todos.filter(p => (p.nombre || '').toLowerCase().includes(filtro))
            : todos;

        document.getElementById('cont-productos').textContent =
            filtro ? lista.length + ' de ' + todos.length : todos.length;

        if (!lista.length) {
            return pintarVacio(cont, filtro ? 'Ningún producto con ese nombre.' : 'Todavía no hay productos.');
        }

        cont.innerHTML = '';
        // Agrupados por categoría, como en la caja: repasar veinte productos
        // mezclados obliga a leerlos todos para saber si falta una cerveza.
        agrupar(lista, p => p.categoria).forEach((productos, categoria) => {
            cont.appendChild(cabeceraGrupo(categoria, productos.length));
            productos.forEach(p => {
                const precio = Number(p.precio_venta).toFixed(2) + ' Bs.';
                cont.appendChild(filaLista({
                    titulo: p.nombre,
                    detalle: [precio, p.stock_actual + ' u.'].join(' · '),
                    insignia: p.vendido > 0 ? 'vendido ' + p.vendido + '×' : '',
                    inactivo: p.activo === 0,
                    foto: urlFoto(p),
                    onEditar: () => abrirEditarProducto(p),
                    marcas: [
                        { texto: 'con acompañante', activa: !!p.requiere_acompanante,
                          onTocar: () => marcarAcompanamiento(p, 'requiere') },
                        { texto: 'es acompañante', activa: !!p.es_acompanante,
                          onTocar: () => marcarAcompanamiento(p, 'es') }
                    ],
                    // La miniatura es el botón: se toca la foto para cambiarla, que
                    // es donde todo el mundo va a tocar de todas formas.
                    onFoto: () => pedirFotoPara(p.id_producto),
                    onQuitarFoto: p.tiene_foto ? () => guardarFotoProducto(p.id_producto, '') : null,
                    onBorrar: () => borrar(
                        '/api/admin/productos/' + p.id_producto,
                        p.vendido > 0
                            ? '"' + p.nombre + '" ya tiene ventas.\n\nSe retirará de la caja pero seguirá ' +
                              'apareciendo en el cierre. ¿Continuar?'
                            : '¿Eliminar "' + p.nombre + '"?',
                        () => { cargarCatalogoAdmin(); loadCatalogSetup(); })
                }));
            });
        });
    }

    // Cambia una de las dos marcas de acompañamiento. Se manda el estado
    // completo y no un "alterna esto": así el servidor no tiene que adivinar
    // nada y dos toques rápidos no pueden dejarlo en un estado a medias.
    async function marcarAcompanamiento(p, cual) {
        const requiere = cual === 'requiere' ? !p.requiere_acompanante : !!p.requiere_acompanante;
        const es = cual === 'es' ? !p.es_acompanante : !!p.es_acompanante;

        // Las dos a la vez no tienen sentido: un producto que pide acompañante
        // no puede ser el acompañante de otro. Se apaga la contraria sola en
        // vez de rechazar el toque y hacer que el encargado adivine por qué.
        const cuerpo = (requiere && es)
            ? { requiere_acompanante: cual === 'requiere', es_acompanante: cual === 'es' }
            : { requiere_acompanante: requiere, es_acompanante: es };

        try {
            const res = await fetch('/api/admin/productos/' + p.id_producto + '/acompanamiento', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cuerpo)
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar.', 'error');
                return;
            }
            notify(data.message, 'ok');
            cargarCatalogoAdmin();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    }

    // ---- Editar un producto -------------------------------------------------
    const editarModal = document.getElementById('editar-modal');
    let productoEditando = null;

    function abrirEditarProducto(p) {
        productoEditando = p;
        document.getElementById('editar-cual').textContent = p.nombre;
        document.getElementById('editar-nombre').value = p.nombre || '';
        document.getElementById('editar-precio').value = Number(p.precio_venta).toFixed(2);
        document.getElementById('editar-descripcion').value = p.descripcion || '';

        const sel = document.getElementById('editar-categoria');
        sel.innerHTML = '';
        (catalogoAdmin.categorias || []).forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id_categoria;
            opt.textContent = c.nombre;
            sel.appendChild(opt);
        });
        sel.value = p.id_categoria || '';

        editarModal.classList.remove('hide');
        document.getElementById('editar-nombre').focus();
    }

    function cerrarEditarProducto() {
        editarModal.classList.add('hide');
        productoEditando = null;
    }

    async function guardarEdicionProducto() {
        if (!productoEditando) return;
        const boton = document.getElementById('editar-guardar');
        boton.disabled = true;
        try {
            const res = await fetch('/api/admin/productos/' + productoEditando.id_producto, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: document.getElementById('editar-nombre').value,
                    descripcion: document.getElementById('editar-descripcion').value,
                    precio_venta: document.getElementById('editar-precio').value,
                    id_categoria: document.getElementById('editar-categoria').value,
                    id_admin: currentUser ? currentUser.id_admin : 1
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo guardar.', 'error', 6000);
                return;
            }
            notify(data.message, 'ok');
            cerrarEditarProducto();
            cargarCatalogoAdmin();
            loadCatalogSetup();
            // La caja tiene que enterarse del precio nuevo antes de la siguiente
            // venta, o seguiría cobrando el viejo hasta recargar.
            fetchProductsAndMenu();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    document.getElementById('editar-cerrar').addEventListener('click', cerrarEditarProducto);
    document.getElementById('editar-guardar').addEventListener('click', guardarEdicionProducto);
    editarModal.addEventListener('click', e => {
        if (e.target === editarModal) cerrarEditarProducto();
    });

    // ---- Personal -----------------------------------------------------------
    let personalAdmin = { cajeros: [], meseros: [] };

    async function cargarPersonalAdmin() {
        try {
            const res = await fetch('/api/admin/personal');
            personalAdmin = await res.json();
        } catch (err) {
            personalAdmin = { cajeros: [], meseros: [] };
        }
        pintarCajeros();
        pintarMeseros();
    }

    function pintarCajeros() {
        const cont = document.getElementById('lista-cajeros');
        if (!cont) return;
        const cajeros = personalAdmin.cajeros || [];
        document.getElementById('cont-cajeros').textContent = cajeros.length;

        if (!cajeros.length) return pintarVacio(cont, 'Todavía no hay cajeros.');

        cont.innerHTML = '';
        cajeros.forEach(c => {
            const partes = [c.usuario];
            if (c.meseros) partes.push(c.meseros + (c.meseros === 1 ? ' mesero' : ' meseros'));
            cont.appendChild(filaLista({
                titulo: c.nombre,
                detalle: partes.join(' · '),
                insignia: c.comandas > 0 ? c.comandas + (c.comandas === 1 ? ' comanda' : ' comandas') : '',
                inactivo: c.activo === 0,
                onBorrar: () => borrar(
                    '/api/admin/cajeros/' + c.id_cajero,
                    c.comandas > 0
                        ? c.nombre + ' ya cobró comandas.\n\nDejará de poder entrar, pero seguirá ' +
                          'apareciendo en el cierre. ¿Continuar?'
                        : '¿Eliminar al cajero ' + c.nombre + '?',
                    () => { cargarPersonalAdmin(); loadPersonalSetup(); })
            }));
        });
    }

    function pintarMeseros() {
        const cont = document.getElementById('lista-meseros');
        if (!cont) return;
        const filtro = (document.getElementById('buscar-mesero').value || '')
            .trim().toLowerCase();
        const todos = personalAdmin.meseros || [];
        // Se busca también por PIN: en mitad del evento, lo que se olvida es el
        // número, no el nombre.
        const lista = filtro
            ? todos.filter(m => (m.nombre || '').toLowerCase().includes(filtro) ||
                                String(m.pin || '').includes(filtro))
            : todos;

        document.getElementById('cont-meseros').textContent =
            filtro ? lista.length + ' de ' + todos.length : todos.length;

        if (!lista.length) {
            return pintarVacio(cont, filtro ? 'Ningún mesero con eso.' : 'Todavía no hay meseros.');
        }

        cont.innerHTML = '';
        // Agrupados por cajero: es como se reparte el trabajo en la barra, y
        // así se ve de un vistazo quién lleva cinco meseros y quién ninguno.
        agrupar(lista, m => m.cajero).forEach((meseros, cajero) => {
            cont.appendChild(cabeceraGrupo(cajero, meseros.length));
            meseros.forEach(m => {
                cont.appendChild(filaLista({
                    titulo: m.nombre,
                        detalle: 'PIN ' + m.pin,
                    insignia: m.comandas > 0 ? m.comandas + (m.comandas === 1 ? ' comanda' : ' comandas') : '',
                    inactivo: m.activo === 0,
                    onBorrar: () => borrar(
                        '/api/admin/meseros/' + m.id_mesero,
                        m.comandas > 0
                            ? m.nombre + ' ya tiene comandas.\n\nSu PIN dejará de funcionar, pero seguirá ' +
                              'apareciendo en el cierre. ¿Continuar?'
                            : '¿Eliminar al mesero ' + m.nombre + '?',
                        () => { cargarPersonalAdmin(); loadPersonalSetup(); })
                }));
            });
        });
    }

    document.getElementById('buscar-producto-cat').addEventListener('input', pintarProductosAdmin);
    document.getElementById('buscar-mesero').addEventListener('input', pintarMeseros);

    // TAB: PERSONAL & BARRAS SETUP
    // `mantenerCajero` conserva el cajero elegido al repintar el desplegable:
    // al dar de alta varios meseros seguidos, todos son del mismo.
    async function loadPersonalSetup(mantenerCajero) {
        try {
            const response = await fetch('/api/admin/configuracion');
            const data = await response.json();

            // La barra no se elige: es la de este servidor. Se enseña sólo
            // para que quede claro dónde va a poder cobrar el cajero.
            pintarBarraDelCajero();

            // Populate Mesero's Cajero selector
            const mesCajero = document.getElementById('mes-cajero');
            const elegido = mantenerCajero || mesCajero.value;
            mesCajero.innerHTML = '<option value="" disabled>Seleccione cajero...</option>';
            data.cajeros.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id_cajero;
                opt.textContent = `${c.nombre} (${c.usuario})`;
                mesCajero.appendChild(opt);
            });
            // Se vuelve a poner el que estaba; si ya no existe, se queda en el
            // aviso de elegir uno.
            mesCajero.value = elegido || '';
            if (!mesCajero.value) mesCajero.selectedIndex = 0;
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
                // Los dos: loadPersonalSetup rellena los desplegables y
                // cargarPersonalAdmin repinta las listas. Antes sólo se llamaba
                // al primero, así que el cajero recién creado no aparecía abajo
                // hasta recargar la página.
                loadPersonalSetup();
                cargarPersonalAdmin();
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

                // reset() borraría también el cajero elegido, y dar de alta
                // quince meseros del mismo cajero obligaría a volver a
                // seleccionarlo quince veces. Se limpian sólo los campos que
                // cambian de una persona a la siguiente.
                ['mes-name', 'mes-user', 'mes-pass'].forEach(id => {
                    document.getElementById(id).value = '';
                });
                document.getElementById('mes-name').focus();

                loadPersonalSetup(id_cajero);
                cargarPersonalAdmin();
            } else {
                notify(data.message || 'No se pudo completar la operación.', 'error');
            }
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        }
    });

    // TAB: ADJUST STOCK SETUP
    // ==========================================
    // INGRESO DE MERCANCÍA (COMPRA O TRASPASO RECIBIDO)
    // ==========================================
    // Dos orígenes y hay que distinguirlos: lo que se compra a un proveedor
    // costó dinero, lo que llega de otra barra ya estaba pagado. Mezclarlos
    // haría imposible saber cuánto se gastó en mercancía esa noche.
    let ingresoMotivo = 'COMPRA';
    let ingresoPendientes = [];

    function pintarIngresoPendientes() {
        const caja = document.getElementById('ingreso-lista');
        if (!caja) return;
        caja.innerHTML = '';

        // El botón dice cuántos lleva la lista: es lo que aclara que guardar
        // registra TODO lo añadido, no sólo lo que se ve escrito arriba.
        const guardar = document.getElementById('ingreso-guardar');
        if (guardar) {
            guardar.textContent = ingresoPendientes.length
                ? 'Guardar ingreso (' + ingresoPendientes.length + ')'
                : 'Guardar ingreso';
        }
        ingresoPendientes.forEach((p, i) => {
            const fila = document.createElement('div');
            fila.className = 'mover-pendiente';
            const txt = document.createElement('span');
            txt.textContent = p.cantidad + ' × ' + p.nombre;
            fila.appendChild(txt);
            const quitar = document.createElement('button');
            quitar.type = 'button';
            quitar.className = 'mover-quitar';
            quitar.textContent = '✕';
            quitar.setAttribute('aria-label', 'Quitar ' + p.nombre);
            quitar.addEventListener('click', () => {
                ingresoPendientes.splice(i, 1);
                pintarIngresoPendientes();
            });
            fila.appendChild(quitar);
            caja.appendChild(fila);
        });
    }

    function apuntarIngreso() {
        const sel = document.getElementById('ingreso-producto');
        const id = parseInt(sel.value, 10);
        const n = parseInt(document.getElementById('ingreso-unidades').value, 10);

        if (!id) { notify('Elige el producto.', 'warn'); return false; }
        if (!Number.isInteger(n) || n <= 0) {
            notify('Pon cuántas unidades llegaron.', 'warn');
            return false;
        }
        ingresoPendientes.push({
            id_producto: id,
            nombre: sel.options[sel.selectedIndex].textContent,
            cantidad: n
        });
        pintarIngresoPendientes();
        document.getElementById('ingreso-unidades').value = '';
        return true;
    }

    async function guardarIngreso() {
        if (!apuntarIngreso()) return;

        const origen = document.getElementById('ingreso-origen').value.trim();
        if (!origen) {
            notify(ingresoMotivo === 'COMPRA'
                ? 'Escribe a qué proveedor se le compró.'
                : 'Escribe de qué barra llega.', 'warn');
            return;
        }

        const boton = document.getElementById('ingreso-guardar');
        boton.disabled = true;
        try {
            const res = await fetch('/api/traspaso', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tipo: 'ENTRADA',
                    motivo: ingresoMotivo,
                    contraparte: origen,
                    observaciones: document.getElementById('ingreso-nota').value.trim(),
                    id_admin: currentUser ? currentUser.id_admin : null,
                    items: ingresoPendientes.map(p => ({ id_producto: p.id_producto, cantidad: p.cantidad }))
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                notify(data.message || 'No se pudo registrar el ingreso.', 'error', 7000);
                return;
            }

            notify(data.message, 'ok', 6000);
            ingresoPendientes = [];
            pintarIngresoPendientes();
            document.getElementById('ingreso-nota').value = '';
            document.getElementById('ingreso-unidades').value = '';
            cargarTraspasos();
            loadStockSetup();
        } catch (err) {
            notify('Sin conexión con el servidor. Revisa el WiFi.', 'error');
        } finally {
            boton.disabled = false;
        }
    }

    document.querySelectorAll('.ingreso-tipo').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ingreso-tipo').forEach(b => b.classList.remove('activa'));
            btn.classList.add('activa');
            ingresoMotivo = btn.dataset.motivo;
            const etiqueta = document.getElementById('ingreso-origen-label');
            const campo = document.getElementById('ingreso-origen');
            if (ingresoMotivo === 'COMPRA') {
                etiqueta.textContent = 'Proveedor';
                campo.placeholder = 'Ej. Distribuidora Central';
            } else {
                etiqueta.textContent = 'Barra de origen';
                campo.placeholder = 'Ej. Barra VIP';
            }
        });
    });

    document.getElementById('ingreso-otro').addEventListener('click', () => { apuntarIngreso(); });
    document.getElementById('ingreso-guardar').addEventListener('click', guardarIngreso);

    // ---- Historial de movimientos de mercancía -----------------------------
    async function cargarTraspasos() {
        const caja = document.getElementById('lista-traspasos');
        if (!caja) return;
        let data;
        try {
            data = await (await fetch('/api/traspasos')).json();
        } catch (err) {
            return pintarVacio(caja, 'No se pudo leer el historial.');
        }

        const lista = data.traspasos || [];
        document.getElementById('cont-traspasos').textContent = lista.length;
        if (!lista.length) {
            return pintarVacio(caja, 'Todavía no hay entradas ni salidas de mercancía.');
        }

        caja.innerHTML = '';
        lista.forEach(t => {
            const sale = t.tipo === 'SALIDA';
            const fila = document.createElement('div');
            fila.className = 'lista-fila';

            const flecha = document.createElement('span');
            flecha.className = 'traspaso-flecha ' + (sale ? 'sale' : 'entra');
            flecha.textContent = sale ? '↗' : '↙';
            flecha.title = sale ? 'Salió de esta barra' : 'Entró a esta barra';
            fila.appendChild(flecha);

            const texto = document.createElement('div');
            texto.className = 'lista-texto';
            const nombre = document.createElement('span');
            nombre.className = 'lista-nombre';
            nombre.textContent = (sale ? 'A ' : (t.motivo === 'COMPRA' ? 'Compra a ' : 'De ')) + t.contraparte;
            texto.appendChild(nombre);
            const sub = document.createElement('span');
            sub.className = 'lista-detalle';
            sub.textContent = ['#' + t.id_traspaso, t.fecha_hora, t.cajero || '']
                .filter(Boolean).join(' · ');
            texto.appendChild(sub);
            fila.appendChild(texto);

            const ins = document.createElement('span');
            ins.className = 'lista-insignia';
            ins.textContent = t.unidades + (t.unidades === 1 ? ' unidad' : ' unidades');
            fila.appendChild(ins);

            caja.appendChild(fila);
        });
    }

    async function loadStockSetup() {
        try {
            const response = await fetch('/api/productos');
            const data = await response.json();

            // Los dos desplegables de la pestaña: el de corregir inventario y
            // el de ingresar mercancía.
            ['stock-product', 'ingreso-producto'].forEach(id => {
                const select = document.getElementById(id);
                if (!select) return;
                select.innerHTML = '<option value="" disabled selected>Seleccione producto...</option>';
                data.productos.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id_producto;
                    opt.textContent = `${p.nombre} (Stock actual: ${p.stock_actual})`;
                    select.appendChild(opt);
                });
            });

            cargarTraspasos();
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
