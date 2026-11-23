(() => {
    // Replace with your deployed Cloudflare Worker URL once deployed (see worker/README.md)
    const CHECKOUT_API_URL = 'https://latelierdamla-checkout.damlasevimm.workers.dev/';
    const STORAGE_KEY = 'latelier_damla_cart_v1';

    function loadCart() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function saveCart(items) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        } catch {
            // Ignore storage errors in private browsing modes
        }
    }

    function formatEur(amount) {
        return new Intl.NumberFormat('en-IE', {
            style: 'currency',
            currency: 'EUR',
            minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
            maximumFractionDigits: 2
        }).format(amount);
    }

    let cart = loadCart();

    // Inject Drawer Markup Once
    const backdrop = document.createElement('div');
    backdrop.className = 'cart-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');

    const drawer = document.createElement('aside');
    drawer.className = 'cart-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Shopping bag');
    drawer.innerHTML = `
        <div class="cart-drawer-header">
            <h2 class="cart-drawer-title">Your Bag</h2>
            <button type="button" class="cart-drawer-close" aria-label="Close shopping bag">&times;</button>
        </div>
        <div class="cart-drawer-body" id="cartDrawerBody"></div>
        <div class="cart-drawer-footer" id="cartDrawerFooter">
            <div class="cart-subtotal-row">
                <span class="cart-subtotal-label">Subtotal</span>
                <span class="cart-subtotal-value" id="cartSubtotal">&euro;0</span>
            </div>
            <p class="cart-shipping-note">Shipping and delivery details are collected at Stripe checkout.</p>
            <div class="cart-error" id="cartError" role="alert"></div>
            <button type="button" class="cart-checkout-btn" id="cartCheckoutBtn">Proceed to Checkout &rarr;</button>
            <div class="cart-powered">Secure checkout powered by Stripe</div>
        </div>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    const bodyEl = drawer.querySelector('#cartDrawerBody');
    const footerEl = drawer.querySelector('#cartDrawerFooter');
    const subtotalEl = drawer.querySelector('#cartSubtotal');
    const errorEl = drawer.querySelector('#cartError');
    const checkoutBtn = drawer.querySelector('#cartCheckoutBtn');
    const closeBtn = drawer.querySelector('.cart-drawer-close');

    function showError(message) {
        errorEl.textContent = message;
        errorEl.classList.add('is-visible');
    }

    function clearError() {
        errorEl.textContent = '';
        errorEl.classList.remove('is-visible');
    }

    function updateCounters() {
        const totalQty = cart.reduce((sum, item) => sum + item.quantity, 0);
        document.querySelectorAll('[data-cart-count]').forEach(el => {
            el.textContent = String(totalQty);
        });
    }

    function renderCart() {
        updateCounters();
        clearError();

        if (cart.length === 0) {
            bodyEl.innerHTML = `
                <div class="cart-empty">
                    <h3>Your bag is empty</h3>
                    <p>Explore our small-batch stoneware cups and hand-built plates.</p>
                    <a href="/shop" class="cart-empty-link">Browse Collection &rarr;</a>
                </div>
            `;
            footerEl.style.display = 'none';
            return;
        }

        footerEl.style.display = 'block';
        bodyEl.innerHTML = '';

        let subtotal = 0;

        cart.forEach(item => {
            subtotal += item.price * item.quantity;

            const row = document.createElement('div');
            row.className = 'cart-item';

            const img = document.createElement('img');
            img.className = 'cart-item-img';
            img.src = item.image;
            img.alt = item.name;

            const info = document.createElement('div');
            info.className = 'cart-item-info';

            const top = document.createElement('div');
            top.className = 'cart-item-top';

            const name = document.createElement('div');
            name.className = 'cart-item-name';
            name.textContent = item.name;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'cart-item-remove';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => removeItem(item.id));

            top.appendChild(name);
            top.appendChild(removeBtn);

            const controls = document.createElement('div');
            controls.className = 'cart-item-controls';

            const qtyBox = document.createElement('div');
            qtyBox.className = 'cart-qty';

            const minusBtn = document.createElement('button');
            minusBtn.type = 'button';
            minusBtn.setAttribute('aria-label', `Decrease quantity of ${item.name}`);
            minusBtn.textContent = '−';
            minusBtn.addEventListener('click', () => updateQuantity(item.id, -1));

            const qtySpan = document.createElement('span');
            qtySpan.textContent = String(item.quantity);

            const plusBtn = document.createElement('button');
            plusBtn.type = 'button';
            plusBtn.setAttribute('aria-label', `Increase quantity of ${item.name}`);
            plusBtn.textContent = '+';
            plusBtn.addEventListener('click', () => updateQuantity(item.id, 1));

            qtyBox.appendChild(minusBtn);
            qtyBox.appendChild(qtySpan);
            qtyBox.appendChild(plusBtn);

            const priceEl = document.createElement('div');
            priceEl.className = 'cart-item-price';
            priceEl.textContent = formatEur(item.price * item.quantity);

            controls.appendChild(qtyBox);
            controls.appendChild(priceEl);

            info.appendChild(top);
            info.appendChild(controls);

            row.appendChild(img);
            row.appendChild(info);
            bodyEl.appendChild(row);
        });

        subtotalEl.textContent = formatEur(subtotal);
    }

    function openDrawer() {
        renderCart();
        backdrop.classList.add('is-open');
        drawer.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        closeBtn.focus();
    }

    function closeDrawer() {
        backdrop.classList.remove('is-open');
        drawer.classList.remove('is-open');
        document.body.style.overflow = '';
    }

    function addItem(item) {
        const existing = cart.find(entry => entry.id === item.id);
        if (existing) {
            existing.quantity += 1;
        } else {
            cart.push({
                id: item.id,
                name: item.name,
                price: parseFloat(item.price),
                image: item.image,
                quantity: 1
            });
        }
        saveCart(cart);
        openDrawer();
    }

    function updateQuantity(id, delta) {
        const idx = cart.findIndex(entry => entry.id === id);
        if (idx === -1) return;
        cart[idx].quantity += delta;
        if (cart[idx].quantity <= 0) {
            cart.splice(idx, 1);
        }
        saveCart(cart);
        renderCart();
    }

    function removeItem(id) {
        cart = cart.filter(entry => entry.id !== id);
        saveCart(cart);
        renderCart();
    }

    async function startStripeCheckout() {
        clearError();

        if (cart.length === 0) return;

        if (CHECKOUT_API_URL.includes('YOUR-WORKER-NAME')) {
            showError('Stripe checkout endpoint is not configured yet. Deploy worker/stripe-checkout-worker.js to Cloudflare Workers and paste its URL into cart.js.');
            return;
        }

        checkoutBtn.disabled = true;
        const originalText = checkoutBtn.innerHTML;
        checkoutBtn.textContent = 'Redirecting to Stripe...';

        try {
            const response = await fetch(CHECKOUT_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: cart.map(item => ({ id: item.id, quantity: item.quantity })),
                    cancelPath: window.location.pathname || '/shop'
                })
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok || !data.url) {
                throw new Error(data.error || 'Could not start Stripe checkout. Please try again.');
            }

            window.location.href = data.url;
        } catch (err) {
            showError(err.message || 'Unable to connect to checkout. Please try again.');
            checkoutBtn.disabled = false;
            checkoutBtn.innerHTML = originalText;
        }
    }

    // Event bindings
    document.addEventListener('click', (event) => {
        const addBtn = event.target.closest('[data-cart-add]');
        if (addBtn) {
            addItem({
                id: addBtn.dataset.itemId,
                name: addBtn.dataset.itemName,
                price: addBtn.dataset.itemPrice,
                image: addBtn.dataset.itemImage
            });
            return;
        }

        const openBtn = event.target.closest('[data-cart-open]');
        if (openBtn) {
            openDrawer();
        }
    });

    closeBtn.addEventListener('click', closeDrawer);
    backdrop.addEventListener('click', closeDrawer);
    checkoutBtn.addEventListener('click', startStripeCheckout);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && drawer.classList.contains('is-open')) {
            closeDrawer();
        }
    });

    // Keep badge synced if cart changes in another tab
    window.addEventListener('storage', (event) => {
        if (event.key === STORAGE_KEY) {
            cart = loadCart();
            renderCart();
        }
    });

    // Public helper (used by success.html to clear bag after completed checkout)
    window.AtelierCart = {
        clear() {
            cart = [];
            saveCart(cart);
            renderCart();
        }
    };

    renderCart();
})();
