(function () {
  const cache = {
    regions: null,
    provinces: new Map(),
    cities: new Map(),
    barangays: new Map()
  };

  const FIELD_MAP = {
    home: 'residential_address',
    current: 'current_address',
    mailing: 'mailing_address',
    'profile-home': 'residential_address',
    'profile-current': 'current_address',
    'profile-mailing': 'mailing_address'
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));

  async function fetchOptions(url, cacheKey, cacheStore) {
    if (cacheStore && cacheStore.has(cacheKey)) return cacheStore.get(cacheKey);
    const response = await apiFetch(url);
    if (!response || !response.ok) {
      const data = response ? await response.json().catch(() => ({})) : {};
      throw new Error(data.error || 'Philippine address dataset unavailable. Please contact the administrator.');
    }
    const data = await response.json();
    if (cacheStore) cacheStore.set(cacheKey, data);
    return data;
  }

  async function getRegions() {
    if (cache.regions) return cache.regions;
    cache.regions = await fetchOptions('/api/address/regions');
    return cache.regions;
  }

  function fillSelect(select, options, placeholder) {
    const selected = select.value;
    select.innerHTML = `<option value="">${placeholder}</option>` + (options || [])
      .map(item => `<option value="${esc(item.value || item.label || item)}">${esc(item.label || item.value || item)}</option>`)
      .join('');
    if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
  }

  function getLineInput(section) {
    return section?.querySelector('[data-ph-address-line]');
  }

  function getLocationInput(section) {
    return section?.querySelector('.address-autocomplete input');
  }

  function buildFullAddress(section) {
    const street = getLineInput(section)?.value.trim()
      || section.querySelector('[data-ph-address-part="street"]')?.value.trim()
      || '';
    const barangay = section.querySelector('[data-ph-address-part="barangay"]')?.value || '';
    const city = section.querySelector('[data-ph-address-part="city_municipality"]')?.value || '';
    const province = section.querySelector('[data-ph-address-part="province"]')?.value || '';
    const region = section.querySelector('[data-ph-address-part="region"]')?.value || '';
    return [street, barangay, city, province, region, 'Philippines'].filter(Boolean).join(', ');
  }

  function syncInputAddress(section) {
    const input = getLocationInput(section);
    if (!input) return;
    input.dataset.fullAddress = buildFullAddress(section);
  }

  async function hydrateAddressSection(section) {
    if (!section || section.dataset.phAddressReady === '1') return;
    const container = section.querySelector('.address-autocomplete');
    const input = container?.querySelector('input');
    const fieldKey = container?.dataset.addressField;
    const prefix = FIELD_MAP[fieldKey];
    if (!container || !input || !prefix) return;

    section.dataset.phAddressReady = '1';
    section.dataset.phAddressPrefix = prefix;
    input.dataset.phAddressPrefix = prefix;
    input.setAttribute('placeholder', 'Search barangay / city / province');
    input.setAttribute('data-ph-address-part', 'location');
    const lineInput = getLineInput(section);
    if (lineInput) {
      lineInput.setAttribute('placeholder', lineInput.getAttribute('placeholder') || 'House no., street, subdivision, unit');
      lineInput.setAttribute('data-ph-address-part', 'street');
    }
  }

  function collectSection(section) {
    const prefix = section?.dataset.phAddressPrefix;
    if (!prefix) return { errors: [], payload: {} };
    const input = getLocationInput(section);
    const lineInput = getLineInput(section);
    const hasSplitAddress = Boolean(lineInput);
    const streetAddress = (hasSplitAddress ? lineInput.value : input?.dataset.streetAddress || input?.value || '').trim();
    const locationAddress = (input?.dataset.fullAddress || input?.value || '').trim();
    const fullAddress = hasSplitAddress
      ? [streetAddress, locationAddress].filter(Boolean).join(', ')
      : locationAddress || streetAddress;
    const payload = {
      [`${prefix}_region`]: input?.dataset.region || '',
      [`${prefix}_province`]: input?.dataset.province || '',
      [`${prefix}_city_municipality`]: input?.dataset.cityMunicipality || '',
      [`${prefix}_barangay`]: input?.dataset.barangay || '',
      [`${prefix}_street_address`]: streetAddress,
      [`${prefix}_full_address`]: fullAddress,
      [`${prefix}_place_id`]: input?.dataset.placeId || null
    };
    const errors = [];
    const label = prefix === 'residential_address' ? 'Home Address' : prefix === 'current_address' ? 'Current Address' : 'Mailing Address';
    if (!payload[`${prefix}_street_address`]) errors.push(`${label} exact address line is required.`);
    if (hasSplitAddress && !locationAddress) errors.push(`${label} barangay / city / province is required.`);
    return { errors, payload };
  }

  function sectionForInput(inputId) {
    const input = document.getElementById(inputId);
    return input?.closest('.form-group, .profile-address-field, label');
  }

  window.initializePhilippineAddressForms = function initializePhilippineAddressForms(scope = document) {
    scope.querySelectorAll?.('.address-autocomplete[data-address-field]').forEach(container => {
      hydrateAddressSection(container.closest('.form-group, .profile-address-field, label'));
    });
  };

  window.collectPhilippineAddressPayload = function collectPhilippineAddressPayload(inputIds = []) {
    const errors = [];
    const payload = {};
    inputIds.forEach(inputId => {
      const result = collectSection(sectionForInput(inputId));
      errors.push(...result.errors);
      Object.assign(payload, result.payload);
    });
    return { errors, payload };
  };

  window.copyPhilippineAddressSection = async function copyPhilippineAddressSection(fromInputId, toInputId) {
    const from = sectionForInput(fromInputId);
    const to = sectionForInput(toInputId);
    if (!from || !to) return;
    const fromInput = document.getElementById(fromInputId);
    const toInput = document.getElementById(toInputId);
    if (fromInput && toInput && window.setAddressSelection) {
      window.setAddressSelection(toInput, fromInput.value, fromInput.dataset.latitude, fromInput.dataset.longitude, fromInput.dataset.placeId, {
        region: fromInput.dataset.region,
        province: fromInput.dataset.province,
        city_municipality: fromInput.dataset.cityMunicipality,
        barangay: fromInput.dataset.barangay,
        street_address: fromInput.dataset.streetAddress,
        full_address: fromInput.dataset.fullAddress || fromInput.value
      });
    }
    const fromLine = getLineInput(from);
    const toLine = getLineInput(to);
    if (fromLine && toLine) toLine.value = fromLine.value;
  };

  window.setPhilippineAddressValues = async function setPhilippineAddressValues(inputId, data = {}) {
    const section = sectionForInput(inputId);
    if (!section) return;
    await hydrateAddressSection(section);
    const prefix = section.dataset.phAddressPrefix;
    const input = document.getElementById(inputId);
    const lineInput = getLineInput(section);
    const value = suffix => data[`${prefix}_${suffix}`] || '';
    if (input) {
      const street = value('street_address') || data[prefix] || '';
      const lat = data[`${prefix}_lat`];
      const lng = data[`${prefix}_lng`];
      const placeId = value('place_id');
      if (lineInput) lineInput.value = value('street_address') || '';
      const location = [
        value('barangay'),
        value('city_municipality'),
        value('province'),
        value('region'),
        value('barangay') || value('city_municipality') || value('province') || value('region') ? 'Philippines' : ''
      ].filter(Boolean).join(', ');
      if (window.setAddressSelection) window.setAddressSelection(input, value('full_address') || street, lat, lng, placeId, {
        region: value('region'),
        province: value('province'),
        city_municipality: value('city_municipality'),
        barangay: value('barangay'),
        street_address: street,
        full_address: value('full_address') || street
      });
      input.value = location || value('full_address') || street;
      input.dataset.fullAddress = location || value('full_address') || street;
      if (!window.setAddressSelection) input.value = location || street;
    }
  };

  window.initializeOnboardingPhilippineAddressForms = function initializeOnboardingPhilippineAddressForms(scope = document) {
    scope.querySelectorAll?.('[data-onb-address]').forEach(async fieldset => {
      if (fieldset.dataset.phOnbReady === '1') return;
      fieldset.dataset.phOnbReady = '1';
      const grid = fieldset.querySelector('.onb-address-grid');
      const provinceInput = fieldset.querySelector('[data-onb-address-part="province"]');
      if (!grid || !provinceInput) return;

      if (!fieldset.querySelector('[data-onb-address-part="region"]')) {
        const label = document.createElement('label');
        label.textContent = 'Region';
        const select = document.createElement('select');
        select.setAttribute('data-onb-address-part', 'region');
        label.appendChild(select);
        grid.insertBefore(label, provinceInput.closest('label'));
      }

      const region = fieldset.querySelector('[data-onb-address-part="region"]');
      const province = replaceOnboardingInput(fieldset, 'province');
      const city = replaceOnboardingInput(fieldset, 'city');
      const barangay = replaceOnboardingInput(fieldset, 'barangay');

      fillSelect(region, await getRegions(), 'Select region');
      fillSelect(province, [], 'Select region first');
      fillSelect(city, [], 'Select province first');
      fillSelect(barangay, [], 'Select city first');
      province.disabled = true;
      city.disabled = true;
      barangay.disabled = true;

      region.addEventListener('change', async () => {
        fillSelect(province, [], 'Select province');
        fillSelect(city, [], 'Select province first');
        fillSelect(barangay, [], 'Select city first');
        province.disabled = !region.value;
        city.disabled = true;
        barangay.disabled = true;
        if (region.value) fillSelect(province, await fetchOptions(`/api/address/provinces/${encodeURIComponent(region.value)}`, region.value, cache.provinces), 'Select province');
        region.dispatchEvent(new Event('input', { bubbles: true }));
      });
      province.addEventListener('change', async () => {
        fillSelect(city, [], 'Select city / municipality');
        fillSelect(barangay, [], 'Select city first');
        city.disabled = !province.value;
        barangay.disabled = true;
        if (province.value) fillSelect(city, await fetchOptions(`/api/address/cities/${encodeURIComponent(province.value)}`, province.value, cache.cities), 'Select city / municipality');
        province.dispatchEvent(new Event('input', { bubbles: true }));
      });
      city.addEventListener('change', async () => {
        fillSelect(barangay, [], 'Select barangay');
        barangay.disabled = !city.value;
        if (city.value) fillSelect(barangay, await fetchOptions(`/api/address/barangays/${encodeURIComponent(city.value)}`, city.value, cache.barangays), 'Select barangay');
        city.dispatchEvent(new Event('input', { bubbles: true }));
      });
      barangay.addEventListener('change', () => {
        barangay.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  };

  function replaceOnboardingInput(fieldset, part) {
    const existing = fieldset.querySelector(`[data-onb-address-part="${part}"]`);
    if (!existing || existing.tagName === 'SELECT') return existing;
    const select = document.createElement('select');
    select.setAttribute('data-onb-address-part', part);
    if (existing.required) select.required = true;
    existing.replaceWith(select);
    return select;
  }
})();
