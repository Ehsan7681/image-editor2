/* ذخیره‌سازی امن (کروم یا لوکال) */
const storage = {
	async get(key) {
		try {
			if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
				const res = await chrome.storage.local.get([key]);
				return res[key];
			}
		} catch (_) {}
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : undefined;
	},
	async set(key, value) {
		try {
			if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
				await chrome.storage.local.set({ [key]: value });
				return;
			}
		} catch (_) {}
		localStorage.setItem(key, JSON.stringify(value));
	}
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

class HistoryStack {
	constructor(limit = 30) {
		this.limit = limit;
		this.items = [];
		this.pointer = -1;
	}
	push(state) {
		// حذف آینده بعد از ویرایش جدید
		this.items = this.items.slice(0, this.pointer + 1);
		this.items.push(state);
		if (this.items.length > this.limit) this.items.shift();
		this.pointer = this.items.length - 1;
	}
	undo() { if (this.pointer > 0) { this.pointer--; return this.items[this.pointer]; } return null; }
	redo() { if (this.pointer < this.items.length - 1) { this.pointer++; return this.items[this.pointer]; } return null; }
}

class ModernImageEditor {
	constructor() {
		this.canvas = document.getElementById('canvas');
		this.ctx = this.canvas.getContext('2d');
		this.overlay = document.getElementById('cropOverlay');
		this.overlayCtx = this.overlay.getContext('2d');
		this.placeholder = document.getElementById('placeholder');

		this.dimensions = [];
		this.quality = 0.9;
		this.keepRatio = true;
		this.keepRatioMulti = true;
		this.transform = { rotate: 0, flipX: false, flipY: false };
		this.filters = { brightness: 100, contrast: 100, saturation: 100, blur: 0, hue: 0, sepia: 0 };
		this.history = new HistoryStack(40);
		this.imageBitmap = null; // منبع اصلی
		this.cropping = { active: false, start: null, end: null, rect: null };

		// تنظیم تم پیش‌فرض
		const currentTheme = document.documentElement.dataset.theme || 'dark';
		this.applyThemeImmediate(currentTheme);

		this.bindUI();
		this.restore();
		
		// تست ذخیره‌سازی بعد از بارگذاری
		setTimeout(() => {
			this.testStorage();
		}, 1000);
	}

	q(sel) { return document.querySelector(sel); }
	qa(sel) { return Array.from(document.querySelectorAll(sel)); }

	bindUI() {
		// پَنِل‌ها
		this.qa('.panel-header').forEach(h => {
			h.addEventListener('click', () => {
				const body = document.querySelector(h.dataset.target);
				body.classList.toggle('open');
			});
		});

		// آپلود
		const uploadArea = this.q('#uploadArea');
		const fileInput = this.q('#fileInput');
		uploadArea.addEventListener('click', () => fileInput.click());
		uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag'); });
		uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag'));
		uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.classList.remove('drag'); if (e.dataTransfer.files[0]) this.loadFile(e.dataTransfer.files[0]); });
		fileInput.addEventListener('change', e => { if (e.target.files[0]) this.loadFile(e.target.files[0]); });

		// فیلترها
		this.mapSlider('#brightness', v => this.setFilter('brightness', v), '#brightnessVal', v => `${v}%`);
		this.mapSlider('#contrast', v => this.setFilter('contrast', v), '#contrastVal', v => `${v}%`);
		this.mapSlider('#saturation', v => this.setFilter('saturation', v), '#saturationVal', v => `${v}%`);
		this.mapSlider('#blur', v => this.setFilter('blur', v), '#blurVal', v => `${v}px`);
		this.mapSlider('#hue', v => this.setFilter('hue', v), '#hueVal', v => `${v}°`);
		this.mapSlider('#sepia', v => this.setFilter('sepia', v), '#sepiaVal', v => `${v}%`);
		this.q('#resetFiltersBtn').addEventListener('click', () => this.resetFilters());

		// تبدیل‌ها
		this.mapSlider('#rotate', v => this.setRotate(parseInt(v, 10)), '#rotateVal', v => `${v}°`);
		this.q('#rotateLeftBtn').addEventListener('click', () => this.nudgeRotate(-90));
		this.q('#rotateRightBtn').addEventListener('click', () => this.nudgeRotate(90));
		this.q('#flipXBtn').addEventListener('click', () => { this.transform.flipX = !this.transform.flipX; this.render(); this.persist(); });
		this.q('#flipYBtn').addEventListener('click', () => { this.transform.flipY = !this.transform.flipY; this.render(); this.persist(); });

		// کراپ
		this.q('#startCropBtn').addEventListener('click', () => this.startCrop());
		this.q('#applyCropBtn').addEventListener('click', () => this.applyCrop());
		this.q('#cancelCropBtn').addEventListener('click', () => this.cancelCrop());
		
		// Mouse events
		this.overlay.addEventListener('mousedown', e => this.onCropDown(e));
		this.overlay.addEventListener('mousemove', e => this.onCropMove(e));
		this.overlay.addEventListener('mouseup', e => this.onCropUp(e));
		
		// Touch events برای موبایل
		this.overlay.addEventListener('touchstart', e => {
			e.preventDefault();
			const touch = e.touches[0];
			this.onCropDown({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} });
		});
		
		this.overlay.addEventListener('touchmove', e => {
			e.preventDefault();
			const touch = e.touches[0];
			this.onCropMove({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} });
		});
		
		this.overlay.addEventListener('touchend', e => {
			e.preventDefault();
			const touch = e.changedTouches[0];
			this.onCropUp({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} });
		});

		// تغییر ابعاد
		this.keepRatioEl = this.q('#keepRatio');
		this.keepRatioEl.addEventListener('change', () => { this.keepRatio = this.keepRatioEl.checked; this.persist(); });
		this.keepRatioMultiEl = this.q('#keepRatioMulti');
		this.keepRatioMultiEl.addEventListener('change', () => { this.keepRatioMulti = this.keepRatioMultiEl.checked; this.persist(); });
		this.q('#applyResizeBtn').addEventListener('click', () => this.applyResize());
		this.q('#downloadResizeBtn').addEventListener('click', () => this.downloadResize());
		this.q('#addDimBtn').addEventListener('click', () => this.addDimension());
		this.q('#clearDimsBtn').addEventListener('click', () => this.clearDimensions());
		this.qa('.chip').forEach(chip => chip.addEventListener('click', () => this.applyPreset(chip.dataset.preset)));

		// کیفیت و خروجی
		this.q('#applyQualityBtn').addEventListener('click', () => this.applyQuality());
		this.q('#downloadBtn').addEventListener('click', () => this.download());
		this.q('#format').addEventListener('change', () => this.renderDimList());

		// چندتایی
		this.q('#exportMultiBtn').addEventListener('click', () => this.exportMultiple());

		// بازنشانی/تاریخچه/تم
		this.q('#resetAllBtn').addEventListener('click', () => this.resetAll());
		this.q('#undoBtn').addEventListener('click', () => this.undo());
		this.q('#redoBtn').addEventListener('click', () => this.redo());
		this.q('#themeToggle').addEventListener('click', () => this.toggleTheme());
		this.q('#testStorageBtn').addEventListener('click', () => this.testStorage());

		window.addEventListener('keydown', (e) => {
			if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
			if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); this.redo(); }
		});
	}

	mapSlider(sel, onInput, valSel, fmt) {
		const el = this.q(sel);
		const out = this.q(valSel);
		const handler = () => { onInput(parseInt(el.value, 10)); out.textContent = fmt(el.value); };
		el.addEventListener('input', handler);
		handler();
	}

	async loadFile(file) {
		if (!file.type.startsWith('image/')) return;
		
		try {
			const url = URL.createObjectURL(file);
			const bmp = await createImageBitmap(await fetch(url).then(r => r.blob()));
			URL.revokeObjectURL(url);
			
			this.imageBitmap = bmp;
			this.fitCanvasToBitmap();
			this.render();
			this.pushHistory();
			this.updateMeta();
			
			// ذخیره فوری تصویر
			await this.persist();
			
			console.log('تصویر با موفقیت بارگذاری شد');
		} catch (e) {
			console.log('خطا در بارگذاری تصویر:', e);
		}
	}

	fitCanvasToBitmap() {
		if (!this.imageBitmap) return;
		this.canvas.width = this.imageBitmap.width;
		this.canvas.height = this.imageBitmap.height;
		this.overlay.width = this.canvas.width;
		this.overlay.height = this.canvas.height;
		this.placeholder.style.display = 'none';
	}

	getFilterCss() {
		const f = this.filters;
		return `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturation}%) blur(${f.blur}px) hue-rotate(${f.hue}deg) sepia(${f.sepia}%)`;
	}

	render() {
		if (!this.imageBitmap) return;
		const { width, height } = this.canvas;
		const ctx = this.ctx;
		ctx.save();
		ctx.clearRect(0, 0, width, height);
		ctx.filter = this.getFilterCss();
		ctx.translate(width / 2, height / 2);
		ctx.scale(this.transform.flipX ? -1 : 1, this.transform.flipY ? -1 : 1);
		ctx.rotate(this.transform.rotate * Math.PI / 180);
		ctx.drawImage(this.imageBitmap, -this.imageBitmap.width / 2, -this.imageBitmap.height / 2);
		ctx.restore();
	}

	setFilter(key, value) {
		this.filters[key] = parseInt(value, 10);
		this.render();
		this.persist();
	}
	resetFilters() {
		this.filters = { brightness: 100, contrast: 100, saturation: 100, blur: 0, hue: 0, sepia: 0 };
		['#brightness','#contrast','#saturation','#blur','#hue','#sepia'].forEach((s, i) => {
			const def = [100,100,100,0,0,0][i];
			const el = this.q(s); el.value = def;
		});
		this.render();
		this.persist();
	}

	setRotate(val) { this.transform.rotate = val; this.render(); this.persist(); }
	nudgeRotate(delta) { this.transform.rotate = (this.transform.rotate + delta) % 360; this.q('#rotate').value = this.transform.rotate; this.render(); this.persist(); }

	startCrop() {
		if (!this.imageBitmap) return;
		this.cropping.active = true;
		this.cropping.start = null;
		this.cropping.end = null;
		this.cropping.rect = null;
		
		// نمایش overlay
		this.overlay.hidden = false;
		this.overlay.style.pointerEvents = 'auto';
		this.overlay.style.cursor = 'crosshair';
		
		// تنظیم اندازه overlay
		this.overlay.width = this.canvas.width;
		this.overlay.height = this.canvas.height;
		
		this.drawOverlay();
		this.q('#applyCropBtn').disabled = true;
		this.q('#cancelCropBtn').disabled = false;
	}
	
	async applyCrop() {
		if (!this.cropping.rect || this.cropping.rect.w < 10 || this.cropping.rect.h < 10) {
			alert('لطفاً ناحیه بزرگتری انتخاب کنید');
			return;
		}
		
		const r = this.cropping.rect;
		
		// ایجاد canvas موقت برای کراپ
		const tempCanvas = document.createElement('canvas');
		const tempCtx = tempCanvas.getContext('2d');
		tempCanvas.width = r.w;
		tempCanvas.height = r.h;
		
		// کپی ناحیه انتخاب شده
		tempCtx.drawImage(this.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
		
		// بروزرسانی canvas اصلی
		this.canvas.width = r.w;
		this.canvas.height = r.h;
		this.ctx.drawImage(tempCanvas, 0, 0);
		
		// بروزرسانی overlay
		this.overlay.width = r.w;
		this.overlay.height = r.h;
		
		// ایجاد ImageBitmap جدید
		this.imageBitmap = await this.canvasToBitmap();
		
		this.stopCrop();
		this.pushHistory();
		this.updateMeta();
		this.persist();
	}
	
	cancelCrop() { 
		this.stopCrop(); 
	}
	
	stopCrop() {
		this.cropping = { active: false, start: null, end: null, rect: null };
		this.overlay.hidden = true;
		this.overlay.style.pointerEvents = 'none';
		this.overlay.style.cursor = 'default';
		this.q('#applyCropBtn').disabled = true;
		this.q('#cancelCropBtn').disabled = true;
	}

	onCropDown(e) { 
		if (!this.cropping.active) return;
		e.preventDefault();
		this.cropping.start = this.eventPos(e);
		this.cropping.end = null;
		this.drawOverlay();
	}
	
	onCropMove(e) { 
		if (!this.cropping.active || !this.cropping.start) return;
		e.preventDefault();
		this.cropping.end = this.eventPos(e);
		this.updateRect();
		this.drawOverlay();
		this.q('#applyCropBtn').disabled = false;
	}
	
	onCropUp(e) { 
		if (!this.cropping.active) return;
		e.preventDefault();
		this.cropping.end = this.eventPos(e);
		this.updateRect();
		this.drawOverlay();
	}

	eventPos(e) { 
		const r = this.overlay.getBoundingClientRect();
		const scaleX = this.overlay.width / r.width;
		const scaleY = this.overlay.height / r.height;
		
		return { 
			x: clamp(Math.round((e.clientX - r.left) * scaleX), 0, this.overlay.width), 
			y: clamp(Math.round((e.clientY - r.top) * scaleY), 0, this.overlay.height) 
		};
	}
	
	updateRect() {
		if (!this.cropping.start || !this.cropping.end) { 
			this.cropping.rect = null; 
			return; 
		}
		
		const x1 = Math.min(this.cropping.start.x, this.cropping.end.x);
		const y1 = Math.min(this.cropping.start.y, this.cropping.end.y);
		const x2 = Math.max(this.cropping.start.x, this.cropping.end.x);
		const y2 = Math.max(this.cropping.start.y, this.cropping.end.y);
		
		this.cropping.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
	}
	
	drawOverlay() {
		const c = this.overlay;
		const ctx = this.overlayCtx;
		
		// پاک کردن overlay
		ctx.clearRect(0, 0, c.width, c.height);
		
		if (!this.cropping.active) return;
		
		// پس‌زمینه تیره
		ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
		ctx.fillRect(0, 0, c.width, c.height);
		
		if (this.cropping.rect) {
			const {x, y, w, h} = this.cropping.rect;
			
			// پاک کردن ناحیه انتخاب شده
			ctx.clearRect(x, y, w, h);
			
			// کشیدن خطوط مرزی
			ctx.strokeStyle = '#7c3aed';
			ctx.lineWidth = 2;
			ctx.setLineDash([5, 5]);
			ctx.strokeRect(x, y, w, h);
			ctx.setLineDash([]);
			
			// کشیدن گوشه‌ها
			const cornerSize = 8;
			ctx.fillStyle = '#7c3aed';
			
			// گوشه بالا چپ
			ctx.fillRect(x - cornerSize/2, y - cornerSize/2, cornerSize, cornerSize);
			// گوشه بالا راست
			ctx.fillRect(x + w - cornerSize/2, y - cornerSize/2, cornerSize, cornerSize);
			// گوشه پایین چپ
			ctx.fillRect(x - cornerSize/2, y + h - cornerSize/2, cornerSize, cornerSize);
			// گوشه پایین راست
			ctx.fillRect(x + w - cornerSize/2, y + h - cornerSize/2, cornerSize, cornerSize);
			
			// نمایش ابعاد
			ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
			ctx.fillRect(x, y - 25, 80, 20);
			ctx.fillStyle = '#ffffff';
			ctx.font = '12px Arial';
			ctx.textAlign = 'center';
			ctx.fillText(`${w} × ${h}`, x + 40, y - 10);
		}
	}

	async applyResize() {
		const wEl = this.q('#resizeWidth'); const hEl = this.q('#resizeHeight');
		let w = parseInt(wEl.value,10); let h = parseInt(hEl.value,10);
		if (!this.imageBitmap || (!w && !h)) return;
		const ratio = this.canvas.width / this.canvas.height;
		if (this.keepRatio) {
			if (w && !h) h = Math.round(w / ratio);
			else if (!w && h) w = Math.round(h * ratio);
		}
		w = Math.max(1, w || this.canvas.width); h = Math.max(1, h || this.canvas.height);
		const off = document.createElement('canvas'); off.width = w; off.height = h;
		off.getContext('2d').drawImage(this.canvas, 0, 0, w, h);
		this.canvas.width = w; this.canvas.height = h; this.overlay.width = w; this.overlay.height = h;
		this.ctx.drawImage(off, 0, 0);
		this.imageBitmap = await this.canvasToBitmap();
		this.pushHistory();
		this.updateMeta();
		this.persist();
	}
	
	downloadResize() {
		if (!this.imageBitmap) return;
		
		const wEl = this.q('#resizeWidth'); const hEl = this.q('#resizeHeight');
		let w = parseInt(wEl.value,10); let h = parseInt(hEl.value,10);
		if (!w && !h) {
			alert('لطفاً ابعاد مورد نظر را وارد کنید');
			return;
		}
		
		const ratio = this.canvas.width / this.canvas.height;
		if (this.keepRatio) {
			if (w && !h) h = Math.round(w / ratio);
			else if (!w && h) w = Math.round(h * ratio);
		}
		w = Math.max(1, w || this.canvas.width); h = Math.max(1, h || this.canvas.height);
		
		// ایجاد canvas موقت برای دانلود
		const off = document.createElement('canvas'); 
		off.width = w; 
		off.height = h;
		const ctx = off.getContext('2d');
		
		// اعمال فیلترها و تبدیل‌ها
		ctx.filter = this.getFilterCss();
		ctx.save();
		ctx.translate(w/2, h/2);
		ctx.scale(this.transform.flipX ? -1 : 1, this.transform.flipY ? -1 : 1);
		ctx.rotate(this.transform.rotate * Math.PI / 180);
		ctx.drawImage(this.imageBitmap, -this.imageBitmap.width/2, -this.imageBitmap.height/2);
		ctx.restore();
		
		// دانلود با فرمت انتخاب شده
		const fmt = this.q('#format').value;
		const mime = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');
		const url = off.toDataURL(mime, this.quality);
		const a = document.createElement('a'); 
		a.href = url; 
		a.download = `resized-${w}x${h}.${fmt==='jpeg'?'jpg':fmt}`; 
		a.click();
	}

	applyPreset(code) {
		const [a,b] = code.split(':').map(Number);
		const w = this.canvas.width; const h = Math.round(w * (b / a));
		this.q('#resizeWidth').value = String(w);
		this.q('#resizeHeight').value = String(h);
	}

	addDimension() {
		const W = parseInt(this.q('#dimWidth').value,10);
		const H = parseInt(this.q('#dimHeight').value,10);
		
		if (!W && !H) {
			alert('لطفاً حداقل یکی از ابعاد را وارد کنید');
			return;
		}
		
		let finalW = W;
		let finalH = H;
		
		// اگر حفظ نسبت فعال باشد و یکی از ابعاد خالی باشد
		if (this.keepRatioMulti && this.imageBitmap) {
			const ratio = this.canvas.width / this.canvas.height;
			
			if (W && !H) {
				finalH = Math.round(W / ratio);
			} else if (!W && H) {
				finalW = Math.round(H * ratio);
			}
		}
		
		// بررسی حداقل اندازه
		finalW = Math.max(1, finalW);
		finalH = Math.max(1, finalH);
		
		// بررسی تکراری نبودن
		if (!this.dimensions.some(d => d.w === finalW && d.h === finalH)) {
			this.dimensions.push({ w: finalW, h: finalH });
			this.renderDimList();
			this.persist();
		} else {
			alert('این ابعاد قبلاً اضافه شده است');
		}
	}
	renderDimList() {
		const wrap = this.q('#dimList'); 
		wrap.innerHTML = '';
		
		if (this.dimensions.length === 0) {
			wrap.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 20px;">هیچ ابعادی اضافه نشده است</div>';
			return;
		}
		
		this.dimensions.forEach((d, i) => {
			const row = document.createElement('div'); 
			row.className = 'row';
			row.style.alignItems = 'center';
			row.style.gap = '8px';
			
			const info = document.createElement('div');
			info.style.flex = '1';
			info.innerHTML = `
				<div style="font-weight: 600; color: var(--text);">${d.w} × ${d.h}</div>
				<div style="font-size: 12px; color: var(--text-dim);">فرمت: ${this.q('#format').value.toUpperCase()}</div>
			`;
			
			const downloadBtn = document.createElement('button'); 
			downloadBtn.className = 'btn success'; 
			downloadBtn.textContent = 'دانلود'; 
			downloadBtn.style.fontSize = '12px';
			downloadBtn.style.padding = '8px 12px';
			downloadBtn.onclick = () => this.downloadScaled(d.w, d.h);
			
			const rm = document.createElement('button'); 
			rm.className = 'btn ghost'; 
			rm.textContent = 'حذف'; 
			rm.style.fontSize = '12px';
			rm.style.padding = '8px 12px';
			rm.onclick = () => { this.dimensions.splice(i,1); this.renderDimList(); this.persist(); };
			
			row.appendChild(info);
			row.appendChild(downloadBtn);
			row.appendChild(rm); 
			wrap.appendChild(row);
		});
	}
	clearDimensions() { this.dimensions = []; this.renderDimList(); this.persist(); }

	applyQuality() {
		const kb = parseInt(this.q('#targetKB').value,10); if (!kb || kb <= 0) return;
		const approxKB = Math.max(1, Math.round(this.canvas.toDataURL('image/jpeg', 1).length * 0.75 / 1024));
		this.quality = clamp(kb / approxKB, 0.1, 1);
		this.persist();
	}

	download() {
		if (!this.imageBitmap) return;
		const fmt = this.q('#format').value;
		const mime = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');
		const url = this.canvas.toDataURL(mime, this.quality);
		const a = document.createElement('a'); a.href = url; a.download = `edited.${fmt==='jpeg'?'jpg':fmt}`; a.click();
	}

	exportMultiple() {
		if (!this.imageBitmap || this.dimensions.length === 0) return;
		this.dimensions.forEach((d, i) => setTimeout(() => this.downloadScaled(d.w, d.h), i * 400));
	}
	downloadScaled(w, h) {
		const off = document.createElement('canvas'); 
		off.width = w; 
		off.height = h; 
		const ctx = off.getContext('2d');
		
		ctx.filter = this.getFilterCss();
		ctx.save(); 
		ctx.translate(w/2,h/2); 
		ctx.scale(this.transform.flipX?-1:1, this.transform.flipY?-1:1); 
		ctx.rotate(this.transform.rotate*Math.PI/180);
		ctx.drawImage(this.imageBitmap, -this.imageBitmap.width/2, -this.imageBitmap.height/2); 
		ctx.restore();
		
		// استفاده از فرمت انتخاب شده
		const fmt = this.q('#format').value;
		const mime = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');
		const url = off.toDataURL(mime, this.quality); 
		const a = document.createElement('a'); 
		a.href = url; 
		a.download = `image-${w}x${h}.${fmt==='jpeg'?'jpg':fmt}`; 
		a.click();
	}

	updateMeta() {
		this.q('#metaDimensions').textContent = `ابعاد: ${this.canvas.width} × ${this.canvas.height}`;
		const estKB = Math.round(this.canvas.toDataURL('image/jpeg', this.quality).length * 0.75 / 1024);
		this.q('#metaSize').textContent = `حجم تقریبی: ${estKB} KB`;
	}


	
	resetAll() {
		if (!confirm('آیا مطمئن هستید که می‌خواهید همه چیز را بازنشانی کنید؟')) return;
		
		// بازنشانی همه تنظیمات
		this.filters = { brightness: 100, contrast: 100, saturation: 100, blur: 0, hue: 0, sepia: 0 };
		this.transform = { rotate: 0, flipX: false, flipY: false };
		this.quality = 0.9;
		this.keepRatio = true;
		this.keepRatioMulti = true;
		this.dimensions = [];
		this.history = new HistoryStack(40);
		
		// بازنشانی UI
		this.resetFilters();
		this.q('#rotate').value = 0;
		this.q('#keepRatio').checked = true;
		this.q('#keepRatioMulti').checked = true;
		this.renderDimList();
		
		// بازنشانی تصویر به حالت اولیه
		if (this.imageBitmap) {
			this.fitCanvasToBitmap();
			this.render();
			this.pushHistory();
			this.updateMeta();
		}
		
		this.persist();
	}

	pushHistory() { try { this.history.push(this.canvas.toDataURL('image/png')); } catch (_) {} }
	undo() { const st = this.history.undo(); if (st) this.restoreFromDataURL(st); }
	redo() { const st = this.history.redo(); if (st) this.restoreFromDataURL(st); }
	async restoreFromDataURL(url) { const bmp = await createImageBitmap(await (await fetch(url)).blob()); this.imageBitmap = bmp; this.fitCanvasToBitmap(); this.render(); this.updateMeta(); this.persist(); }

	async canvasToBitmap() {
		const url = this.canvas.toDataURL('image/png');
		const blob = await (await fetch(url)).blob();
		return await createImageBitmap(blob);
	}

	async persist() {
		// ذخیره تصویر اصلی (بدون فیلترها و تبدیل‌ها)
		let imageData = null;
		if (this.imageBitmap) {
			try {
				// ایجاد canvas موقت برای ذخیره تصویر اصلی
				const tempCanvas = document.createElement('canvas');
				const tempCtx = tempCanvas.getContext('2d');
				tempCanvas.width = this.imageBitmap.width;
				tempCanvas.height = this.imageBitmap.height;
				
				// کشیدن تصویر اصلی بدون فیلتر
				tempCtx.drawImage(this.imageBitmap, 0, 0);
				imageData = tempCanvas.toDataURL('image/png');
			} catch (e) {
				console.log('خطا در ذخیره تصویر:', e);
			}
		}
		
		const data = { 
			quality: this.quality, 
			keepRatio: this.keepRatio, 
			keepRatioMulti: this.keepRatioMulti,
			filters: this.filters, 
			transform: this.transform, 
			dims: this.dimensions, 
			theme: document.documentElement.dataset.theme || 'dark',
			imageData: imageData,
			originalWidth: this.imageBitmap ? this.imageBitmap.width : null,
			originalHeight: this.imageBitmap ? this.imageBitmap.height : null,
			canvasWidth: this.canvas.width,
			canvasHeight: this.canvas.height
		};
		
		try {
			await storage.set('modernImageEditorData', data);
		} catch (e) {
			console.log('خطا در ذخیره داده‌ها:', e);
		}
	}
	async restore() {
		try {
			const d = await storage.get('modernImageEditorData');
			if (!d) return;
			
			// اعمال تم ذخیره شده - باید اول انجام شود
			if (d.theme) {
				document.documentElement.dataset.theme = d.theme;
				this.applyThemeStyles();
			}
			
			// بازیابی تنظیمات
			this.quality = d.quality ?? this.quality;
			this.keepRatio = d.keepRatio ?? this.keepRatio;
			this.keepRatioMulti = d.keepRatioMulti ?? this.keepRatioMulti;
			this.filters = { ...this.filters, ...(d.filters||{}) };
			this.transform = { ...this.transform, ...(d.transform||{}) };
			this.dimensions = d.dims || [];
			
			// sync UI - باید قبل از بازیابی تصویر انجام شود
			this.q('#keepRatio').checked = this.keepRatio;
			this.q('#keepRatioMulti').checked = this.keepRatioMulti;
			this.q('#brightness').value = this.filters.brightness;
			this.q('#contrast').value = this.filters.contrast;
			this.q('#saturation').value = this.filters.saturation;
			this.q('#blur').value = this.filters.blur;
			this.q('#hue').value = this.filters.hue;
			this.q('#sepia').value = this.filters.sepia;
			this.q('#rotate').value = this.transform.rotate;
			this.renderDimList();
			
			// بازیابی تصویر ذخیره شده
			if (d.imageData) {
				try {
					// ایجاد ImageBitmap از داده ذخیره شده
					const response = await fetch(d.imageData);
					const blob = await response.blob();
					const bmp = await createImageBitmap(blob);
					
					this.imageBitmap = bmp;
					
					// تنظیم اندازه canvas بر اساس تصویر اصلی
					if (d.originalWidth && d.originalHeight) {
						this.canvas.width = d.originalWidth;
						this.canvas.height = d.originalHeight;
						this.overlay.width = d.originalWidth;
						this.overlay.height = d.originalHeight;
					} else {
						this.canvas.width = bmp.width;
						this.canvas.height = bmp.height;
						this.overlay.width = bmp.width;
						this.overlay.height = bmp.height;
					}
					
					this.placeholder.style.display = 'none';
					
					// اعمال فیلترها و تبدیل‌ها روی تصویر بازیابی شده
					this.render();
					this.updateMeta();
					
					console.log('تصویر با موفقیت بازیابی شد');
				} catch (e) {
					console.log('خطا در بازیابی تصویر:', e);
				}
			}
		} catch (e) {
			console.log('خطا در بازیابی داده‌ها:', e);
		}
	}

	setTheme(theme) { 
		document.documentElement.dataset.theme = theme; 
		this.applyThemeStyles();
		this.persist(); 
	}
	
	// اعمال فوری تم بدون ذخیره‌سازی
	applyThemeImmediate(theme) {
		document.documentElement.dataset.theme = theme;
		this.applyThemeStyles();
	}
	
	// تابع تست برای بررسی ذخیره‌سازی
	async testStorage() {
		try {
			const data = await storage.get('modernImageEditorData');
			console.log('داده‌های ذخیره شده:', data);
			if (data && data.imageData) {
				console.log('تصویر ذخیره شده موجود است');
				console.log('اندازه تصویر:', data.originalWidth, 'x', data.originalHeight);
			} else {
				console.log('تصویر ذخیره شده موجود نیست');
			}
		} catch (e) {
			console.log('خطا در تست ذخیره‌سازی:', e);
		}
	}
	toggleTheme() { 
		const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; 
		this.setTheme(t); 
	}
	applyThemeStyles() {
		const theme = document.documentElement.dataset.theme || 'dark';
		
		if (theme === 'light') {
			// حالت روشن
			document.documentElement.style.setProperty('--bg', '#f8fafc');
			document.documentElement.style.setProperty('--card', '#ffffff');
			document.documentElement.style.setProperty('--muted', '#f1f5f9');
			document.documentElement.style.setProperty('--text', '#0f172a');
			document.documentElement.style.setProperty('--text-dim', '#475569');
			document.documentElement.style.setProperty('--primary', '#7c3aed');
			document.documentElement.style.setProperty('--primary-600', '#6d28d9');
			document.documentElement.style.setProperty('--ring', 'rgba(124, 58, 237, 0.25)');
			document.documentElement.style.setProperty('--success', '#22c55e');
			document.documentElement.style.setProperty('--warn', '#f59e0b');
			document.documentElement.style.setProperty('--error', '#ef4444');
			
			// تغییر آیکون تم
			if (this.q('#themeToggle')) {
				this.q('#themeToggle').textContent = '☀️';
			}
		} else {
			// حالت تاریک (پیش‌فرض)
			document.documentElement.style.removeProperty('--bg');
			document.documentElement.style.removeProperty('--card');
			document.documentElement.style.removeProperty('--muted');
			document.documentElement.style.removeProperty('--text');
			document.documentElement.style.removeProperty('--text-dim');
			document.documentElement.style.removeProperty('--primary');
			document.documentElement.style.removeProperty('--primary-600');
			document.documentElement.style.removeProperty('--ring');
			document.documentElement.style.removeProperty('--success');
			document.documentElement.style.removeProperty('--warn');
			document.documentElement.style.removeProperty('--error');
			
			// تغییر آیکون تم
			if (this.q('#themeToggle')) {
				this.q('#themeToggle').textContent = '🌙';
			}
		}
	}
}

window.addEventListener('DOMContentLoaded', () => {
	// اطمینان از اعمال تم درست در ابتدای بارگذاری
	const savedTheme = localStorage.getItem('modernImageEditorData');
	if (savedTheme) {
		try {
			const data = JSON.parse(savedTheme);
			if (data.theme) {
				document.documentElement.dataset.theme = data.theme;
			}
		} catch (e) {
			console.log('خطا در خواندن تم ذخیره شده:', e);
		}
	}
	
	new ModernImageEditor();
});


