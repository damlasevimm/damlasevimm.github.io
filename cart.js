(() => {
    // Your deployed Cloudflare Worker base URL (see worker/README.md)
    const CHECKOUT_API_URL = 'https://latelierdamla-checkout.damlasevimm.workers.dev/';
    const WORKER_BASE_URL = CHECKOUT_API_URL.replace(/\/create-checkout-session\/?$/, '').replace(/\/+$/, '');
    const STORAGE_KEY = 'latelier_damla_cart_v1';
    const FREE_SHIPPING_THRESHOLD = 50; // Free shipping for orders higher than €50

    let liveStock = null; // Map of { [productId]: number } once loaded from Worker /inventory

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

    function getStockFor(id) {
        if (!liveStock || typeof liveStock[id] !== 'number') return null;
        return liveStock[id];
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
            <p class="cart-shipping-note" id="cartShippingNote">Free shipping on orders over &euro;50 (&euro;8 standard shipping).</p>
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
    const shippingNoteEl = drawer.querySelector('#cartShippingNote');
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

    function applyStockToProductCards() {
        if (!liveStock) return;

        document.querySelectorAll('[data-cart-add]').forEach(btn => {
            const id = btn.dataset.itemId;
            const available = getStockFor(id);
            if (available === null) return;

            const row = btn.closest('.art-purchase-row, .product-purchase-row');
            const priceEl = row ? row.querySelector('.art-price, .product-price') : null;

            let note = row ? row.querySelector('.stock-note') : null;
            if (!note && priceEl) {
                note = document.createElement('span');
                note.className = 'stock-note';
                priceEl.insertAdjacentElement('afterend', note);
            }

            if (available <= 0) {
                btn.disabled = true;
                btn.classList.add('is-sold-out');
                btn.textContent = 'Sold Out';
                if (note) {
                    note.textContent = 'Sold Out';
                    note.classList.add('is-sold-out');
                }
            } else {
                btn.disabled = false;
                btn.classList.remove('is-sold-out');
                btn.textContent = '+ Add to Bag';
                if (note) {
                    note.classList.remove('is-sold-out');
                    note.textContent = available <= 3 ? `Only ${available} left` : '';
                }
            }
        });
    }

    function reconcileCartWithStock() {
        if (!liveStock) return false;
        let changed = false;

        cart = cart.reduce((acc, item) => {
            const available = getStockFor(item.id);
            if (available === null) {
                acc.push(item);
                return acc;
            }
            if (available <= 0) {
                changed = true;
                return acc;
            }
            if (item.quantity > available) {
                changed = true;
                acc.push({ ...item, quantity: available });
                return acc;
            }
            acc.push(item);
            return acc;
        }, []);

        if (changed) {
            saveCart(cart);
        }
        return changed;
    }

    async function fetchLiveInventory() {
        if (WORKER_BASE_URL.includes('YOUR-WORKER-NAME')) return;

        try {
            const res = await fetch(`${WORKER_BASE_URL}/inventory`, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.stock && typeof data.stock === 'object') {
                liveStock = data.stock;
                applyStockToProductCards();
                reconcileCartWithStock();
                renderCart();
            }
        } catch {
            // Silently keep checkout working even if pre-fetch is offline
        }
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
            const available = getStockFor(item.id);
            const atLimit = available !== null && item.quantity >= available;

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
            plusBtn.disabled = atLimit;
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

            if (available !== null && available <= 3) {
                const limitNote = document.createElement('div');
                limitNote.className = 'cart-item-stock-limit';
                limitNote.textContent = atLimit
                    ? `Maximum available (${available})`
                    : `Only ${available} available`;
                info.appendChild(limitNote);
            }

            row.appendChild(img);
            row.appendChild(info);
            bodyEl.appendChild(row);
        });

        subtotalEl.textContent = formatEur(subtotal);

        if (subtotal > FREE_SHIPPING_THRESHOLD) {
            shippingNoteEl.textContent = 'You have unlocked free tracked shipping!';
            shippingNoteEl.classList.add('is-free');
        } else {
            shippingNoteEl.textContent = subtotal < FREE_SHIPPING_THRESHOLD
                ? `Free shipping on orders over €50 — add more than ${formatEur(FREE_SHIPPING_THRESHOLD - subtotal)} to qualify (€8 standard shipping).`
                : 'Free shipping applies on orders over €50 (€8 standard shipping).';
            shippingNoteEl.classList.remove('is-free');
        }
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
        const available = getStockFor(item.id);
        if (available !== null && available <= 0) {
            return;
        }

        const existing = cart.find(entry => entry.id === item.id);
        if (existing) {
            if (available !== null && existing.quantity >= available) {
                openDrawer();
                showError(`Only ${available} left for ${item.name}.`);
                return;
            }
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

        const available = getStockFor(id);
        const nextQty = cart[idx].quantity + delta;

        if (available !== null && nextQty > available) {
            showError(`Only ${available} left for ${cart[idx].name}.`);
            return;
        }

        cart[idx].quantity = nextQty;
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

        if (WORKER_BASE_URL.includes('YOUR-WORKER-NAME')) {
            showError('Stripe checkout endpoint is not configured yet. Deploy worker/stripe-checkout-worker.js to Cloudflare Workers and paste its URL into cart.js.');
            return;
        }

        checkoutBtn.disabled = true;
        const originalText = checkoutBtn.innerHTML;
        checkoutBtn.textContent = 'Redirecting to Stripe...';

        try {
            const response = await fetch(`${WORKER_BASE_URL}/create-checkout-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: cart.map(item => ({ id: item.id, quantity: item.quantity })),
                    cancelPath: window.location.pathname || '/shop'
                })
            });

            const data = await response.json().catch(() => ({}));

            if (data && data.stock && typeof data.stock === 'object') {
                liveStock = data.stock;
                applyStockToProductCards();
                reconcileCartWithStock();
                renderCart();
            }

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
        if (addBtn && !addBtn.disabled) {
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
    fetchLiveInventory();
})();
