/* Рабочие слои: ГИС-контроль и ремонтно-восстановительные работы.
   Исходные объекты загружены из KML. Правки хранятся отдельно от исходных
   данных, поэтому повторная выгрузка KML не уничтожит внесённые изменения. */
(function () {
  'use strict';

  // Виды работ для площадок РВР (импортируются из таблицы, редактируются
  // через карточку админом). Ключ — короткий код, значение — подпись.
  const TASK_LABELS = {
    paint: 'Покраска',
    sand: 'Завоз песка'
  };

  // Короткая подпись для точки на карте: без "№NN —" и канцелярских оборотов —
  // только улица/проспект/микрорайон + номер.
  function shortAddressLabel(name) {
    return (name || '')
      .replace(/^№\d+\s*[—-]\s*/, '')
      .replace(/в районе жилого дома/gi, '')
      .replace(/в районе дома/gi, '')
      .replace(/в районе д\.?/gi, '')
      .replace(/жилого дома/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/,\s*,/g, ',')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .trim();
  }

  const sections = {
    gis: {
      title: 'ГИС-контроль',
      searchPlaceholder: 'Адрес, кадастровый номер или объект',
      collection: 'gis_control_overrides',
      data: Array.isArray(window.GIS_CONTROL_DATA) ? window.GIS_CONTROL_DATA : [],
      legend: 'ГИС-контроль: границы зон ответственности, детские площадки и административные сектора.',
      markerColor: '#d6432e'
    },
    repair: {
      title: 'Ремонтные работы',
      searchPlaceholder: 'Адрес, сектор или вид работ',
      collection: 'repair_works_overrides',
      data: Array.isArray(window.REPAIR_WORKS_DATA) ? window.REPAIR_WORKS_DATA : [],
      legend: 'Ремонтно-восстановительные работы: кадастровые зоны, площадки и сектора.',
      markerColor: '#9c27b0'
    }
  };

  // Файлы данных (gis-control-data.js / repair-works-data.js) — обычные <script>,
  // подключаемые ДО multi-sections.js. Если файл не загрузился (404, не тот
  // регистр имени, обрыв при заливке на хостинг) — window.*_DATA останется
  // undefined, а секция молча станет пустой без единой ошибки на экране.
  // Фиксируем это здесь и показываем баннер при инициализации.
  const missingDataFiles = [];
  if (!Array.isArray(window.GIS_CONTROL_DATA)) missingDataFiles.push('gis-control-data.js');
  if (!Array.isArray(window.REPAIR_WORKS_DATA)) missingDataFiles.push('repair-works-data.js');
  if (Array.isArray(window.GIS_CONTROL_DATA) && window.GIS_CONTROL_DATA.length === 0) missingDataFiles.push('gis-control-data.js (файл загрузился, но в нём 0 объектов)');
  if (Array.isArray(window.REPAIR_WORKS_DATA) && window.REPAIR_WORKS_DATA.length === 0) missingDataFiles.push('repair-works-data.js (файл загрузился, но в нём 0 объектов)');

  function showDataLoadWarning() {
    if (!missingDataFiles.length) return;
    const banner = document.getElementById('data-load-warning');
    if (!banner) return;
    banner.querySelector('.data-load-warning-text').textContent =
      '⚠️ Не удалось загрузить данные: ' + missingDataFiles.join(', ') +
      '. Разделы «ГИС-контроль» / «Ремонтные работы» будут пустыми, пока этот файл не окажется в той же папке на сервере, что и index.html, с точным именем (регистр важен), без обрыва при загрузке.';
    banner.classList.remove('hidden');
  }

  let activeSection = 'gis';
  let checkedTasks = new Set(); // по умолчанию ничего не выбрано — все точки видны серым
  let showPointLabels = false; // подпись с адресом над точкой — по желанию, через фильтр
  let featureLayer;
  let featureLayerById = new Map();
  let storedFeatureOverrides = { gis: new Map(), repair: new Map() };
  let persistenceMode = { gis: 'firebase', repair: 'firebase' };
  let sectionUnsubscribers = {};

  // ===== Плавающая карточка объекта (вместо полноэкранной панели) =====
  let cardFeatureId = null;
  let cardHighlightLayer = null;
  let cardDragState = null;

  const originalRenderActiveMarkers = renderActiveMarkers;
  const originalHandleSearch = handleSearch;

  // ВАЖНО: этот файл — обычный синхронный <script>, выполняется сразу при
  // парсинге страницы, ДО DOMContentLoaded. А глобальная `map` создаётся
  // (L.map(...)) только внутри initMap(), которая вызывается по
  // DOMContentLoaded. Поэтому всё, что трогает `map`, нельзя ставить на
  // верхний уровень модуля — иначе map ещё undefined, .addTo(undefined)/
  // map.off(...) кидают исключение, весь IIFE падает, и переключение
  // вкладок вообще не навешивается. Вынесено в setupMapDependent(),
  // которая вызывается из initialise() уже после готовности карты.
  function setupMapDependent() {
    featureLayer = L.layerGroup().addTo(map);

    // Оригинальная карта мусора продолжает работать только в своём разделе.
    window.renderActiveMarkers = function () {
      if (activeSection === 'trash') originalRenderActiveMarkers();
    };

    // Клик по карте должен добавлять точку вывоза мусора только в разделе
    // «Вывоз мусора». В разделах ГИС-контроль/Ремонтные работы объекты
    // редактируются через карточку объекта, а не кликом по пустой карте.
    // Исходный обработчик снимается и заменяется — просто переопределить
    // window.onMapClick недостаточно, т.к. Leaflet уже держит ссылку на
    // исходную функцию, привязанную через map.on('click', onMapClick).
    map.off('click', onMapClick);
    map.on('click', function (e) {
      if (activeSection === 'trash') {
        onMapClick(e);
      } else if (zoneDrawing) {
        zoneDrawAddVertex(e.latlng);
      } else if (window.handleRegistryMapClick) {
        window.handleRegistryMapClick(e.latlng);
      }
    });
    // Двойной клик завершает рисование зоны (Leaflet стреляет click+dblclick — берём dblclick)
    map.on('dblclick', function (e) {
      if (zoneDrawing) {
        L.DomEvent.stop(e);
        // Последний клик от dblclick дублирует вершину — убираем если совпадает
        if (zoneVertices.length >= 2) {
          const last = zoneVertices[zoneVertices.length - 1];
          const prev = zoneVertices[zoneVertices.length - 2];
          if (Math.abs(last.lat - prev.lat) < 1e-7 && Math.abs(last.lng - prev.lng) < 1e-7) {
            zoneVertices.pop();
            const dot = zoneVertexMarkers.pop();
            if (dot) featureLayer.removeLayer(dot);
          }
        }
        window.finishZoneDraw();
      }
    });

    // Плавающая карточка следует за точкой/зоной при панорамировании, вращении и зуме.
    map.on('move zoom rotate drag', function () { if (cardFeatureId) updateCardLine(); });
    window.addEventListener('resize', function () { if (cardFeatureId) updateCardLine(); });
    setupFeatureCard();
  }

  function sectionDefinition() {
    return sections[activeSection];
  }

  function featureText(value) {
    return String(value == null ? '' : value)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .trim();
  }

  function getFeatureCenter(feature) {
    if (feature.geometry.type === 'Point') return feature.geometry.coordinates;
    const all = [];
    (feature.geometry.coordinates || []).forEach(ring => ring.forEach(point => all.push(point)));
    if (!all.length) return { lat: TEMIRTAU_CENTER[0], lng: TEMIRTAU_CENTER[1] };
    return {
      lat: all.reduce((sum, point) => sum + Number(point.lat), 0) / all.length,
      lng: all.reduce((sum, point) => sum + Number(point.lng), 0) / all.length
    };
  }

  function cleanAddressName(name) {
    if (!name) return '';
    let cleaned = String(name).replace(/№№/g, '№').replace(/\bN\s*N\b/gi, '').trim();
    if (cleaned.startsWith('—')) cleaned = cleaned.replace(/^—\s*/, '');
    return cleaned || String(name);
  }

  function extensionForFeature(feature) {
    const center = getFeatureCenter(feature);
    const cleanName = cleanAddressName(feature.name);
    return {
      id: feature.id,
      name: cleanName || 'Без названия',
      description: feature.description || '',
      folder: feature.folder || 'Без категории',
      style: feature.style || {},
      geometry: feature.geometry,
      photo1Url: feature.photo1Url || null,
      photo2Url: feature.photo2Url || null,
      tasks: feature.tasks || null,
      center
    };
  }

  function getFeatures(sectionKey) {
    const section = sections[sectionKey];
    if (!section || !Array.isArray(section.data)) return [];
    const overrides = storedFeatureOverrides[sectionKey] || new Map();

    // Добавляем isNew-точки из Firestore которых нет в статичном section.data
    // (нужно при обновлении страницы — section.data загружен из .js файла без новых точек)
    const baseIds = new Set(section.data.map(f => f.id));
    overrides.forEach((change, id) => {
      if (change.isNew && !baseIds.has(id) && !change.deleted && change.geometry && change.name) {
        section.data.push({
          id,
          name: change.name,
          folder: change.folder || 'Без категории',
          description: change.description || '',
          geometry: change.geometry,
          style: change.style || {}
        });
        baseIds.add(id);
      }
    });

    return section.data
      .filter(base => {
        const change = overrides.get(base.id) || {};
        if (change.deleted) return false;
        const name = (change.name == null ? base.name : change.name) || '';
        const trimmed = String(name).trim();
        if (/^N\s*N$/i.test(trimmed) || /^№\s*№$/i.test(trimmed) || trimmed === 'N' || trimmed === '№' || !trimmed) return false;
        const geo = change.geometry || base.geometry;
        if (!geo || !geo.type || !geo.coordinates) return false;
        if (geo.type === 'Point') {
          const c = geo.coordinates;
          if (!c || typeof c.lat !== 'number' || typeof c.lng !== 'number' || isNaN(c.lat) || isNaN(c.lng) || c.lat === 0) return false;
        } else if (geo.type === 'Polygon' || geo.type === 'MultiPolygon') {
          if (!Array.isArray(geo.coordinates) || !geo.coordinates.length) return false;
        } else {
          return false;
        }
        return true;
      })
      .map(base => {
        const change = overrides.get(base.id) || {};
        return extensionForFeature({
          ...base,
          name: change.name == null ? base.name : change.name,
          description: change.description == null ? base.description : change.description,
          folder: change.folder == null ? base.folder : change.folder,
          style: change.style || base.style || {},
          geometry: change.geometry || base.geometry,
          photo1Url: change.photo1Url || null,
          photo2Url: change.photo2Url || null,
          tasks: change.tasks || null
        });
      });
  }


  function setLegend(text) {
    const legend = document.getElementById('zone-legend');
    legend.textContent = text || '';
    legend.classList.toggle('hidden', !text);
  }

  function pointIcon(color) {
    return L.divIcon({
      className: 'custom-pin',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      html: `<span style="display:block;width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.34)"><i style="display:block;width:6px;height:6px;border-radius:50%;background:#fff;margin:6px auto"></i></span>`
    });
  }

  function polygonLatLngs(feature) {
    const rings = feature.geometry.coordinates || [];
    if (feature.geometry.type === 'Polygon') return rings.map(ring => ring.map(point => [point.lat, point.lng]));
    return rings.map(ring => [ring.map(point => [point.lat, point.lng])]);
  }

  // ===== Двуязычный словарь (RU / KK) =====
  const I18N = {
    ru: {
      gis_title: 'ГИС-контроль',
      repair_title: 'Ремонтные работы',
      trash_title: 'Вывоз мусора',
      gis_placeholder: 'Адрес, кадастровый номер или объект',
      repair_placeholder: 'Адрес, сектор или вид работ',
      trash_placeholder: 'Адрес или координаты',
      coords_btn: 'Коорд.',
      open_card: 'Открыть карточку',
      no_desc: 'Описание отсутствует',
      edit_btn: '✏️ Редактировать',
      delete_btn: '🗑 Удалить с карты',
      objects_count: 'объектов в разделе',
      search_in_list: 'Поиск в списке',
      found: 'Найдено',
      not_found: 'Ничего не найдено.',
      lang_code: 'ҚАЗ',
      // Каталог
      addresses_in_registry: 'адресов в реестре',
      copy_all_addresses: '📋 Скопировать все адреса',
      search_by_address: 'Поиск по адресу или микрорайону',
      copy_district_addresses: 'Скопировать адреса этого микрорайона',
      route_yards: 'Маршрут по дворам (Google Maps)',
      other_outside: 'Прочие / вне границ',
      nothing_found: 'Ничего не найдено.',
      // Карточка объекта
      zone_center: 'Центр зоны',
      point_type: 'площадка / точка',
      zone_type: 'зона ответственности',
      object_id: 'ID объекта',
      type_label: 'Тип',
      copy_coords: 'копировать',
      objects_label: 'Объекты',
      // Редактирование
      edit_title: 'Редактирование объекта',
      name_label: 'Название / адрес',
      lat_label: 'Широта',
      lng_label: 'Долгота',
      zone_hint: 'Границы зоны сохранены из исходного KML. Здесь можно изменить её название и описание.',
      desc_label: 'Описание / кадастровый номер / работы',
      cancel_btn: 'Отмена',
      save_btn: 'Сохранить',
      // Тосты
      saved_toast: 'Изменения сохранены',
      deleted_toast: 'Объект удалён с карты',
      no_name_toast: 'Укажите название объекта',
      check_coords_toast: 'Проверьте координаты',
      delete_confirm: 'Удалить объект',
      delete_from_map: 'с карты',
      // Раздел адресов
      addr_modal_title: 'Скопировать адреса',
      addr_copy_btn: '📋 Скопировать в буфер',
      addr_close_btn: 'Закрыть',
      all_registry_addr: 'Все адреса реестра',
      copied_toast: 'Адреса скопированы в буфер',
      all_copied_toast: 'Скопировано все адреса',
      no_addresses_toast: 'В реестре нет адресов для копирования',
      // Добавление точки
      add_point_btn: '➕ Добавить точку',
      add_point_title: 'Новая точка',
      cadastre_label: 'Кадастровый номер',
      area_label: 'Площадь (кв.м)',
      category_label: 'Категория',
      cat_gis_boundaries: 'Кадастровые границы',
      cat_gis_playground: 'Детские площадки',
      cat_gis_sector: 'Административные сектора',
      cat_repair_works: 'Площадки для РВР',
      click_map_hint: '📍 Кликните на карту чтобы выбрать координаты',
      add_point_toast: 'Точка добавлена',
      add_zone_btn: '🗺 Добавить зону',
      add_zone_title: 'Новая зона',
      draw_zone_hint: '🖊 Кликайте по карте — ставьте вершины. Двойной клик — завершить.',
      draw_zone_active: 'Режим рисования. Вершин: ',
      draw_zone_min: 'Нужно хотя бы 3 вершины',
      draw_zone_cancel: 'Отменить рисование',
      draw_zone_finish: '✓ Завершить зону',
      add_zone_toast: 'Зона добавлена',
      // Маршрут (route panel)
      route_title: 'Маршрут',
      route_from: 'Откуда',
      route_to: 'Куда',
      route_drive: '🚗 Авто',
      route_walk: '🚶 Пешком',
      route_build: 'Проложить маршрут',
      route_btn_title: 'Построить маршрут',
      // История
      history_title: 'История вывоза',
      list_label: 'Список',
      // Язык
      lang_toast: 'Язык: Русский',
      // Плашка авторов
      authors_title: 'Авторы карты:',
      // Попап маршрута
      route_popup: '🧭 Маршрут'
    },
    kk: {
      gis_title: 'ГИС-бақылау',
      repair_title: 'Жөндеу жұмыстары',
      trash_title: 'Қоқыс шығару',
      gis_placeholder: 'Мекенжай, кадастрлық нөмір немесе объект',
      repair_placeholder: 'Мекенжай, сектор немесе жұмыс түрі',
      trash_placeholder: 'Мекенжай немесе координаттар',
      coords_btn: 'Коорд.',
      open_card: 'Карточканы ашу',
      no_desc: 'Сипаттамасы жоқ',
      edit_btn: '✏️ Редакциялау',
      delete_btn: '🗑 Картадан жою',
      objects_count: 'бөлімдегі объектілер',
      search_in_list: 'Тізімнен іздеу',
      found: 'Табылды',
      not_found: 'Ештеңе табылмады.',
      lang_code: 'РУС',
      // Каталог
      addresses_in_registry: 'тізімдегі мекенжайлар',
      copy_all_addresses: '📋 Барлық мекенжайларды көшіру',
      search_by_address: 'Мекенжай немесе шағын аудан бойынша іздеу',
      copy_district_addresses: 'Осы шағын аудан мекенжайларын көшіру',
      route_yards: 'Аулалар бойынша маршрут (Google Maps)',
      other_outside: 'Өзгелер / шекарадан тыс',
      nothing_found: 'Ештеңе табылмады.',
      // Карточка объекта
      zone_center: 'Аймақ орталығы',
      point_type: 'алаң / нүкте',
      zone_type: 'жауапкершілік аймағы',
      object_id: 'Объект ID',
      type_label: 'Түрі',
      copy_coords: 'көшіру',
      objects_label: 'Объектілер',
      // Редактирование
      edit_title: 'Объектіні редакциялау',
      name_label: 'Атауы / мекенжайы',
      lat_label: 'Ендік',
      lng_label: 'Бойлық',
      zone_hint: 'Аймақ шекаралары бастапқы KML-ден сақталған. Мұнда атауы мен сипаттамасын өзгертуге болады.',
      desc_label: 'Сипаттама / кадастрлық нөмір / жұмыстар',
      cancel_btn: 'Болдырмау',
      save_btn: 'Сақтау',
      // Тосты
      saved_toast: 'Өзгерістер сақталды',
      deleted_toast: 'Объект картадан жойылды',
      no_name_toast: 'Объект атауын көрсетіңіз',
      check_coords_toast: 'Координаттарды тексеріңіз',
      delete_confirm: 'Объектіні жою',
      delete_from_map: 'картадан',
      // Раздел адресов
      addr_modal_title: 'Мекенжайларды көшіру',
      addr_copy_btn: '📋 Алмасу буферіне көшіру',
      addr_close_btn: 'Жабу',
      all_registry_addr: 'Барлық тізім мекенжайлары',
      copied_toast: 'Мекенжайлар алмасу буферіне көшірілді',
      all_copied_toast: 'Барлық мекенжайлар көшірілді',
      no_addresses_toast: 'Тізімде көшіруге мекенжай жоқ',
      // Добавление точки
      add_point_btn: '➕ Нүкте қосу',
      add_point_title: 'Жаңа нүкте',
      cadastre_label: 'Кадастрлық нөмір',
      area_label: 'Ауданы (шм²)',
      category_label: 'Санат',
      cat_gis_boundaries: 'Кадастрлық шекаралар',
      cat_gis_playground: 'Балалар алаңдары',
      cat_gis_sector: 'Әкімшілік секторлар',
      cat_repair_works: 'ЖҚЖ алаңдары',
      click_map_hint: '📍 Координаттарды таңдау үшін картаны басыңыз',
      add_point_toast: 'Нүкте қосылды',
      add_zone_btn: '🗺 Аймақ қосу',
      add_zone_title: 'Жаңа аймақ',
      draw_zone_hint: '🖊 Картаны басып төбелерді қойыңыз. Екі рет басу — аяқтау.',
      draw_zone_active: 'Сызу режимі. Төбелер: ',
      draw_zone_min: 'Кемінде 3 төбе қажет',
      draw_zone_cancel: 'Сызуды болдырмау',
      draw_zone_finish: '✓ Аймақты аяқтау',
      add_zone_toast: 'Аймақ қосылды',
      // Маршрут (route panel)
      route_title: 'Маршрут',
      route_from: 'Қайдан',
      route_to: 'Қайда',
      route_drive: '🚗 Авто',
      route_walk: '🚶 Жаяу',
      route_build: 'Маршрут салу',
      route_btn_title: 'Маршрут салу',
      // История
      history_title: 'Шығару тарихы',
      list_label: 'Тізім',
      // Язык
      lang_toast: 'Тіл: Қазақша',
      // Плашка авторов
      authors_title: 'Карта авторлары:',
      // Попап маршрута
      route_popup: '🧭 Маршрут'
    }
  };

  let currentLang = localStorage.getItem('trash-map-lang') || 'ru';

  function t(key) {
    return (I18N[currentLang] && I18N[currentLang][key]) || (I18N.ru && I18N.ru[key]) || key;
  }

  function translateToKazakh(s) {
    if (!s) return '';
    return String(s)
      // ── Полные фразы (длинные — первыми) ──
      .replace(/Официальное название:/gi, 'Ресми атауы:')
      .replace(/Кадастровый номер:/gi, 'Кадастрлық нөмірі:')
      .replace(/Площадь из отчета:/gi, 'Есептегі ауданы:')
      .replace(/Площадь по данным отчёта:/gi, 'Есептегі ауданы:')
      .replace(/Назначение:/gi, 'Мақсаты:')
      .replace(/в районе жилых домов/gi, 'тұрғын үйлер аумағында')
      .replace(/в районе жилого дома/gi, 'тұрғын үй аумағында')
      .replace(/Кадастровые границы/gi, 'Кадастрлық шекаралар')
      .replace(/Кадастровые Зоны/gi, 'Кадастрлық аймақтар')
      .replace(/Кадастровая зона/gi, 'Кадастрлық аймақ')
      .replace(/Административные сектора/gi, 'Әкімшілік секторлар')
      .replace(/Административный сектор/gi, 'Әкімшілік сектор')
      .replace(/Детские площадки/gi, 'Балалар алаңдары')
      .replace(/Детская площадка/gi, 'Балалар алаңы')
      .replace(/Площадки для РВР/gi, 'ЖҚЖ алаңдары')
      .replace(/Ремонтно-восстановительные работы/gi, 'Жөндеу-қалпына келтіру жұмыстары')
      .replace(/Ремонтные работы/gi, 'Жөндеу жұмыстары')
      .replace(/нежилое помещение/gi, 'тұрғын емес үй-жай')
      .replace(/Без категории/gi, 'Санатсыз')
      .replace(/Без названия/gi, 'Атаусыз')
      .replace(/Прочие \/ вне границ/gi, 'Өзгелер / шекарадан тыс')
      .replace(/Зона ответственности/gi, 'Жауапкершілік аймағы')
      .replace(/зона ответственности/gi, 'жауапкершілік аймағы')
      .replace(/Описание отсутствует/gi, 'Сипаттамасы жоқ')
      // ── Типы улиц / территорий ──
      .replace(/проспект/gi, 'даңғылы')
      .replace(/пр\./gi, 'даңғ.')
      .replace(/улица/gi, 'көшесі')
      .replace(/ул\./gi, 'көш.')
      .replace(/микрорайон/gi, 'шағын ауданы')
      .replace(/\bмкр\./gi, 'ш.а.')
      .replace(/\bмкр\b/gi, 'ш.а.')
      .replace(/квартал/gi, 'орамы')
      .replace(/\bкв\./gi, 'орам.')
      .replace(/переулок/gi, 'тұйық көшесі')
      .replace(/\bпер\./gi, 'т.к.')
      .replace(/бульвар/gi, 'бульвары')
      .replace(/\bбул\./gi, 'бул.')
      .replace(/сектор/gi, 'секторы')
      .replace(/сквер/gi, 'саябағы')
      .replace(/парк/gi, 'паркі')
      .replace(/площадь/gi, 'алаңы')
      .replace(/набережная/gi, 'жағалауы')
      .replace(/территория/gi, 'аумақ')
      .replace(/гаражи/gi, 'гараждар')
      // ── Части / характеристики ──
      .replace(/\bЧасть\b/gi, 'Бөлігі')
      .replace(/\bчасть\b/gi, 'бөлігі')
      .replace(/Жилой дом/gi, 'Тұрғын үй')
      .replace(/жилой дом/gi, 'тұрғын үй')
      .replace(/жилые дома/gi, 'тұрғын үйлер')
      .replace(/многоквартирный/gi, 'көппәтерлі')
      // ── Поля описания объекта (кадастр и др.) ──
      .replace(/Кадастровый номер:/gi, 'Кадастрлық нөмірі:')
      .replace(/Площадь:/gi, 'Ауданы:')
      .replace(/Общая площадь:/gi, 'Жалпы ауданы:')
      .replace(/Категория:/gi, 'Санаты:')
      .replace(/Статус:/gi, 'Мәртебесі:')
      .replace(/Тип:/gi, 'Түрі:')
      .replace(/Вид разрешенного использования:/gi, 'Рұқсат етілген пайдалану түрі:')
      .replace(/Точная площадь:/gi, 'Нақты ауданы:')
      // ── Категории земель ──
      .replace(/Земли населённых пунктов (городов, поселков и сельских населённых пунктов)/gi, 'Елді мекенжайлар жері (қалалар, кенттер мен ауылдық елді мекенжайлар)')
      .replace(/Земли населенных пунктов (городов, поселков и сельских населенных пунктов)/gi, 'Елді мекенжайлар жері (қалалар, кенттер мен ауылдық елді мекенжайлар)')
      .replace(/земли населённых пунктов/gi, 'елді мекенжайлар жері')
      .replace(/земли населенных пунктов/gi, 'елді мекенжайлар жері')
      .replace(/Земли сельскохозяйственного назначения/gi, 'Ауыл шаруашылық мақсаттағы жерлер')
      .replace(/земли сельскохозяйственного назначения/gi, 'ауыл шаруашылық мақсаттағы жерлер')
      .replace(/Земли промышленности/gi, 'Өнеркәсіптік жерлер')
      .replace(/земли промышленности/gi, 'өнеркәсіптік жерлер')
      .replace(/Земли транспорта/gi, 'Көлік жерлері')
      .replace(/земли транспорта/gi, 'көлік жерлері')
      // ── Единицы измерения ──
      .replace(/кв\.\s*м\b/gi, 'м²')
      .replace(/кв\. м/gi, 'шм²')
      .replace(/кв\.м/gi, 'шм²');
  }

  function localizeText(text) {
    const raw = featureText(text);
    return currentLang === 'kk' ? translateToKazakh(raw) : raw;
  }

  function updateAppLanguage() {
    const langBtn = document.getElementById('lang-btn');
    if (langBtn) langBtn.textContent = currentLang === 'ru' ? 'ҚАЗ' : 'РУС';
    
    // Обновление вкладок
    document.querySelectorAll('.section-tab').forEach(tab => {
      if (tab.dataset.section === 'gis') tab.textContent = t('gis_title');
      if (tab.dataset.section === 'repair') tab.textContent = t('repair_title');
      if (tab.dataset.section === 'trash') tab.textContent = t('trash_title');
    });

    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      if (activeSection === 'gis') searchInput.placeholder = t('gis_placeholder');
      else if (activeSection === 'repair') searchInput.placeholder = t('repair_placeholder');
      else searchInput.placeholder = t('trash_placeholder');
    }

    // Кнопка маршрута
    const routeBtn = document.getElementById('route-btn');
    if (routeBtn) routeBtn.title = t('route_btn_title');

    // Панель маршрута
    const routeTitle = document.getElementById('route-panel-title');
    if (routeTitle) routeTitle.textContent = t('route_title');
    const routeFromInput = document.getElementById('route-from-input');
    if (routeFromInput) routeFromInput.placeholder = t('route_from');
    const routeToInput = document.getElementById('route-to-input');
    if (routeToInput) routeToInput.placeholder = t('route_to');
    const routeBuildBtn = document.getElementById('route-build-btn');
    if (routeBuildBtn) routeBuildBtn.textContent = t('route_build');
    const routeDriveBtn = document.getElementById('route-profile-driving');
    if (routeDriveBtn) routeDriveBtn.textContent = t('route_drive');
    const routeWalkBtn = document.getElementById('route-profile-foot');
    if (routeWalkBtn) routeWalkBtn.textContent = t('route_walk');

    // Кнопка истории
    const histBtn = document.getElementById('history-btn');
    if (histBtn && activeSection === 'trash') histBtn.title = t('history_title');

    // Модальное окно адресов
    const addrModalTitle = document.getElementById('addr-modal-title');
    // (не сбрасываем — там динамический заголовок с именем группы)
    const addrCopyBtn = document.querySelector('#addr-modal .btn-primary');
    if (addrCopyBtn) addrCopyBtn.textContent = t('addr_copy_btn');
    const addrCloseBtn = document.querySelector('#addr-modal .btn-secondary');
    if (addrCloseBtn) addrCloseBtn.textContent = t('addr_close_btn');

    // Заголовок панели «i» (информация об авторах) — только если открыт каталог реестра
    if (activeSection !== 'trash') {
      const panelTitleEl = document.getElementById('panel-title');
      if (panelTitleEl && panelType === 'registry-list') {
        panelTitleEl.textContent = `${t('objects_label')}: ${sectionDefinition().title}`;
      }
    }

    if (activeSection !== 'trash') renderRegistryLayer();
    if (window.renderLandmarks) window.renderLandmarks();
    if (cardFeatureId) window.openFeatureCard(cardFeatureId);
    // Обновляем открытый каталог
    if (panelType === 'registry-list') renderCatalog();
  }

  function toggleLanguage() {
    currentLang = currentLang === 'ru' ? 'kk' : 'ru';
    localStorage.setItem('trash-map-lang', currentLang);
    updateAppLanguage();
    showToast(currentLang === 'ru' ? 'Язык: Русский' : 'Тіл: Қазақша');
  }

  function isMicrorayonSector(feature) {
    return feature.folder === 'Административные сектора' || feature.folder === 'Temirtau_Sektora.kml';
  }

  function linkFeatures(features) {
    const mapByName = new Map();
    features.forEach(f => {
      const norm = (f.name || '').toLowerCase().trim();
      if (!norm) return;
      if (!mapByName.has(norm)) mapByName.set(norm, []);
      mapByName.get(norm).push(f);
    });

    features.forEach(f => {
      f._linkedIds = [];
      const norm = (f.name || '').toLowerCase().trim();
      const sameName = mapByName.get(norm) || [];
      sameName.forEach(other => {
        if (other.id !== f.id && !f._linkedIds.includes(other.id)) {
          f._linkedIds.push(other.id);
        }
      });
    });
  }

  function renderRegistryLayer() {
    closeFeatureCard();
    featureLayer.clearLayers();
    featureLayerById.clear();
    if (activeSection === 'trash') return;

    const section = sectionDefinition();
    const features = getFeatures(activeSection);
    linkFeatures(features);

    features.forEach(feature => {
      let layer;

      // Если объект — границы микрорайона / сектора:
      // Отображается зона с подписью по центру, клики проходят СКВОЗЬ неё на объекты внутри
      if (isMicrorayonSector(feature)) {
        if (feature.geometry.type !== 'Point') {
          const style = feature.style || {};
          layer = L.polygon(polygonLatLngs(feature), {
            color: style.color || '#0E5C4F',
            dashArray: '5, 5',
            weight: 1.5,
            opacity: Number(style.opacity == null ? 0.6 : style.opacity),
            fillColor: style.fillColor || '#0E5C4F',
            fillOpacity: 0.06,
            interactive: false
          });
          featureLayer.addLayer(layer);
        }

        // Текстовая подпись с названием микрорайона/сектора (чистый текст без обводок)
        const labelMarker = L.marker([feature.center.lat, feature.center.lng], {
          icon: L.divIcon({
            className: 'microrayon-label',
            html: `<span>${escapeHtml(localizeText(feature.name))}</span>`
          }),
          interactive: false
        });
        featureLayer.addLayer(labelMarker);
        return;
      }

      if (feature.geometry.type === 'Point') {
        const ptColor = (feature.style && feature.style.pointColor) || section.markerColor;   // скопированные из ГИС площадки — фиолетовые (pointColor), остальные — обычный цвет секции
        layer = L.marker([feature.center.lat, feature.center.lng], { icon: pointIcon(ptColor), title: feature.name });
        layer._baseColor = ptColor;
      } else {
        const style = feature.style || {};
        const fallbackColor = colorForCategory(feature.folder);
        layer = L.polygon(polygonLatLngs(feature), {
          color: style.color || fallbackColor,
          opacity: Number(style.opacity == null ? .9 : style.opacity),
          weight: Number(style.weight || 2),
          fillColor: style.fillColor || style.color || fallbackColor,
          fillOpacity: Number(style.fillOpacity == null ? .12 : style.fillOpacity)
        });
      }
      layer.on('click', () => window.openFeatureCard(feature.id));
      featureLayer.addLayer(layer);
      featureLayerById.set(feature.id, layer);
      if (layer.bringToBack) layer.bringToBack();
    });
    updateSectionBadge();
  }

  // ── Фильтр по видам работ (только раздел «Ремонтные работы») ──
  // Логика чек-листа: все галочки включены по умолчанию — видно всё.
  // У площадки берём её невыполненные виды работ; если хотя бы один из них
  // всё ещё отмечен галочкой (или у площадки вовсе нет невыполненных работ) —
  // площадка видна. Сняли галочку с вида работы — площадки, которым нужен
  // только он, пропадают; те, кому нужно что-то ещё отмеченное, остаются.
  const TASK_FILTER_COLOR_GRAY = '#8a8f99';
  const TASK_FILTER_COLOR_GREEN = '#2fae56';

  // Невыполненные виды работ площадки среди известных сейчас типов (TASK_LABELS) —
  // старые типы из прежнего импорта (mow, rvr, tennis_board и т.п.) сюда не попадают,
  // точно так же как их не показывает карточка.
  function pendingTaskKeys(f) {
    if (!f.tasks || typeof f.tasks !== 'object') return [];
    return Object.entries(f.tasks).filter(([key, done]) => TASK_LABELS[key] && done === false).map(([k]) => k);
  }

  function refreshTaskFilterHighlight() {
    if (activeSection !== 'repair') return;
    const noFilter = checkedTasks.size === 0;
    const allFeatures = getFeatures('repair');
    linkFeatures(allFeatures); // getFeatures() каждый раз создаёт новые объекты — связку точка↔зона нужно пересчитать на этом же наборе
    const byId = new Map(allFeatures.map(f => [f.id, f]));

    allFeatures.forEach(f => {
      try {
        const layer = featureLayerById.get(f.id);
        if (!layer) return;

        if (f.folder === 'Площадки для РВР') {
          if (noFilter) {
            if (!featureLayer.hasLayer(layer)) featureLayer.addLayer(layer);
            if (layer.setIcon) { layer.setIcon(pointIcon(TASK_FILTER_COLOR_GRAY)); layer._baseColor = TASK_FILTER_COLOR_GRAY; }
          } else {
            const show = pendingTaskKeys(f).some(k => checkedTasks.has(k));
            if (show) {
              if (!featureLayer.hasLayer(layer)) featureLayer.addLayer(layer);
              if (layer.setIcon) { layer.setIcon(pointIcon(TASK_FILTER_COLOR_GREEN)); layer._baseColor = TASK_FILTER_COLOR_GREEN; }
            } else if (featureLayer.hasLayer(layer)) {
              featureLayer.removeLayer(layer);
            }
          }
        } else if (f.folder === 'Кадастровые Зоны') {
          let show = true;
          if (!noFilter) {
            const linked = (f._linkedIds || []).map(id => byId.get(id)).filter(Boolean);
            const rvrLinked = linked.filter(lf => lf.folder === 'Площадки для РВР');
            show = rvrLinked.length ? rvrLinked.some(lf => pendingTaskKeys(lf).some(k => checkedTasks.has(k))) : true;
          }
          if (show) { if (!featureLayer.hasLayer(layer)) featureLayer.addLayer(layer); }
          else if (featureLayer.hasLayer(layer)) { featureLayer.removeLayer(layer); }
        }
      } catch (err) {
        console.warn('refreshTaskFilterHighlight error for', f.id, err);
      }
    });
    applyPointLabels();
    renderTaskFilterMenu();
  }

  function applyPointLabels() {
    getFeatures('repair').filter(f => f.folder === 'Площадки для РВР').forEach(f => {
      const layer = featureLayerById.get(f.id);
      if (!layer || !layer.bindTooltip) return;
      const visible = featureLayer.hasLayer(layer);
      if (showPointLabels && visible) {
        if (!layer.getTooltip()) {
          layer.bindTooltip(escapeHtml(shortAddressLabel(f.name)), {
            permanent: true, direction: 'top', offset: [0, -28], className: 'rvr-point-label'
          });
        }
      } else if (layer.getTooltip()) {
        layer.unbindTooltip();
      }
    });
  }

  function renderTaskFilterMenu() {
    const menu = document.getElementById('rvr-task-filter-menu');
    const btn = document.getElementById('rvr-task-filter-btn');
    if (!menu) return;
    const features = getFeatures('repair').filter(f => f.folder === 'Площадки для РВР');
    const counts = {};
    features.forEach(f => {
      if (!f.tasks) return;
      Object.entries(f.tasks).forEach(([key, done]) => {
        if (done === false) counts[key] = (counts[key] || 0) + 1;
      });
    });
    const items = Object.keys(TASK_LABELS).filter(key => counts[key] > 0);
    menu.innerHTML = items.length ? items.map(key => `
      <label class="rvr-task-filter-item">
        <input type="checkbox" class="rvr-task-filter-checkbox" data-task="${key}" ${checkedTasks.has(key) ? 'checked' : ''}>
        <span style="flex:1;">${TASK_LABELS[key]}</span>
        <span class="rvr-task-filter-count">${counts[key]}</span>
      </label>
    `).join('') : `<div class="rvr-task-filter-item" style="cursor:default;">Нет активных задач</div>`;
    if (items.length) {
      menu.innerHTML += `<div class="rvr-task-filter-item rvr-task-filter-clear" id="rvr-task-filter-showall">Сбросить (показать всё серым)</div>`;
    }
    menu.innerHTML += `
      <label class="rvr-task-filter-item" style="border-top:1px solid rgba(0,0,0,.1); margin-top:4px; padding-top:8px;">
        <input type="checkbox" id="rvr-show-labels-checkbox" ${showPointLabels ? 'checked' : ''}>
        <span style="flex:1;">Показывать названия точек на карте</span>
      </label>
    `;
    menu.querySelectorAll('.rvr-task-filter-checkbox').forEach(el => {
      el.addEventListener('change', () => {
        const key = el.dataset.task;
        if (el.checked) checkedTasks.add(key); else checkedTasks.delete(key);
        refreshTaskFilterHighlight();
      });
    });
    const showAllBtn = document.getElementById('rvr-task-filter-showall');
    if (showAllBtn) {
      showAllBtn.addEventListener('click', () => {
        checkedTasks = new Set();
        refreshTaskFilterHighlight();
      });
    }
    const labelsCheckbox = document.getElementById('rvr-show-labels-checkbox');
    if (labelsCheckbox) {
      labelsCheckbox.addEventListener('change', () => {
        showPointLabels = labelsCheckbox.checked;
        applyPointLabels();
      });
    }
    if (btn) btn.textContent = checkedTasks.size ? '🟢' : '⚪';
  }

  function updateSectionBadge() {
    const badge = document.getElementById('history-badge');
    if (activeSection === 'trash') {
      updateHistoryBadge();
      return;
    }
    badge.textContent = getFeatures(activeSection).length;
  }

  function replaceControl(id, eventName, handler) {
    const oldNode = document.getElementById(id);
    if (!oldNode) return null;
    const replacement = oldNode.cloneNode(true);
    oldNode.replaceWith(replacement);
    replacement.addEventListener(eventName, handler);
    return replacement;
  }

  function configureTopControls() {
    const input = replaceControl('search-input', 'keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); if (window.hideSearchSuggestions) window.hideSearchSuggestions(); runSearch(); }
      if (event.key === 'Escape' && window.hideSearchSuggestions) window.hideSearchSuggestions();
    });
    if (input) {
      input.placeholder = 'Адрес или координаты';
      if (window.updateSearchSuggestions) {
        let suggestTimer = null;
        input.addEventListener('input', (e) => {
          clearTimeout(suggestTimer);
          const val = e.target.value;
          suggestTimer = setTimeout(() => window.updateSearchSuggestions(val), 120);
        });
        input.addEventListener('focus', (e) => {
          if (e.target.value.trim().length >= 2) window.updateSearchSuggestions(e.target.value);
        });
        input.addEventListener('blur', () => setTimeout(window.hideSearchSuggestions, 150));
      }
    }
    replaceControl('search-btn', 'click', () => { if (window.hideSearchSuggestions) window.hideSearchSuggestions(); runSearch(); });
    replaceControl('history-btn', 'click', openCurrentCatalog);

    const langBtn = document.getElementById('lang-btn');
    if (langBtn) {
      langBtn.addEventListener('click', toggleLanguage);
    }
  }

  function switchSection(nextSection) {
    if (!['gis', 'repair'].includes(nextSection)) return;
    activeSection = nextSection;
    closePanel();
    closeFeatureCard();
    document.querySelectorAll('.section-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.section === nextSection));

    const searchInput = document.getElementById('search-input');
    const historyButton = document.getElementById('history-btn');
    const filterWrap = document.getElementById('rvr-task-filter-wrap');
    if (nextSection === 'trash') {
      if (filterWrap) filterWrap.style.display = 'none';
      featureLayer.clearLayers();
      setLegend('');
      searchInput.placeholder = t('trash_placeholder');
      historyButton.title = t('history_title');
      originalRenderActiveMarkers();
      updateHistoryBadge();
      return;
    }

    if (filterWrap) filterWrap.style.display = nextSection === 'repair' ? '' : 'none';
    if (nextSection !== 'repair') checkedTasks = new Set();
    pointsLayer.clearLayers();
    const section = sectionDefinition();
    searchInput.placeholder = nextSection === 'gis' ? t('gis_placeholder') : t('repair_placeholder');
    historyButton.title = `${t('list_label')}: ${section.title}`;
    setLegend(section.legend);
    renderRegistryLayer();
    if (nextSection === 'repair') refreshTaskFilterHighlight();
  }

  function findFeature(id) {
    return getFeatures(activeSection).find(feature => feature.id === id) || null;
  }

  // ----- Плавающая карточка: DOM, драг, линия-указатель -----
  function cardEls() {
    return {
      card: document.getElementById('feature-card'),
      title: document.getElementById('feature-card-title'),
      body: document.getElementById('feature-card-body'),
      lineWrap: document.getElementById('feature-line-svg-wrap'),
      line: document.getElementById('feature-line'),
      lineOutline: document.getElementById('feature-line-outline'),
      dot: document.getElementById('feature-line-dot'),
      dotOutline: document.getElementById('feature-line-dot-outline')
    };
  }

  function setupFeatureCard() {
    const els = cardEls();
    if (!els.card) return;
    document.getElementById('feature-card-close').addEventListener('click', closeFeatureCard);
    const handle = document.getElementById('feature-card-drag');
    function pointFromEvent(e) { return e.touches ? e.touches[0] : e; }
    function onDown(e) {
      if (e.target.closest('.feature-card-close')) return;
      const p = pointFromEvent(e);
      const rect = els.card.getBoundingClientRect();
      cardDragState = { startX: p.clientX, startY: p.clientY, origLeft: rect.left, origTop: rect.top };
      if (e.pointerId != null && handle.setPointerCapture) { try { handle.setPointerCapture(e.pointerId); } catch (err) { } }
    }
    function onMove(e) {
      if (!cardDragState) return;
      const p = pointFromEvent(e);
      const margin = 8;
      let left = cardDragState.origLeft + (p.clientX - cardDragState.startX);
      let top = cardDragState.origTop + (p.clientY - cardDragState.startY);
      left = Math.max(margin, Math.min(window.innerWidth - els.card.offsetWidth - margin, left));
      top = Math.max(margin, Math.min(window.innerHeight - els.card.offsetHeight - margin, top));
      els.card.style.left = left + 'px';
      els.card.style.top = top + 'px';
      updateCardLine();
    }
    function onUp() { cardDragState = null; }
    handle.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function projectToScreen(lat, lng) {
    const pt = map.latLngToContainerPoint([lat, lng]);
    const rect = map.getContainer().getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  }

  function edgePointTowards(rect, tx, ty) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const scaleX = dx ? (rect.width / 2) / Math.abs(dx) : Infinity;
    const scaleY = dy ? (rect.height / 2) / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY, 1e6);
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  function positionCardNear(target) {
    const els = cardEls();
    const margin = 14;
    els.card.classList.remove('hidden');
    els.card.style.left = '-2000px';
    els.card.style.top = '-2000px';
    const w = els.card.offsetWidth;
    const h = els.card.offsetHeight;
    let left = target.x + 26;
    let top = target.y - h - 18;
    if (left + w > window.innerWidth - margin) left = target.x - w - 26;
    if (left < margin) left = margin;
    if (top < margin) top = target.y + 26;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - h - margin;
    if (top < margin) top = margin;
    els.card.style.left = left + 'px';
    els.card.style.top = top + 'px';
  }

  function updateCardLine() {
    if (!cardFeatureId) return;
    const feature = findFeature(cardFeatureId);
    if (!feature) { closeFeatureCard(); return; }
    const els = cardEls();
    const target = projectToScreen(feature.center.lat, feature.center.lng);
    const rect = els.card.getBoundingClientRect();
    const start = edgePointTowards(rect, target.x, target.y);
    [els.lineOutline, els.line].forEach(line => {
      line.setAttribute('x1', start.x);
      line.setAttribute('y1', start.y);
      line.setAttribute('x2', target.x);
      line.setAttribute('y2', target.y);
    });
    els.dotOutline.setAttribute('cx', target.x);
    els.dotOutline.setAttribute('cy', target.y);
    els.dot.setAttribute('cx', target.x);
    els.dot.setAttribute('cy', target.y);
  }

  let cardHighlightLayers = [];

  function clearCardHighlight() {
    cardHighlightLayers.forEach(layer => {
      if (layer._origStyle && layer.setStyle) {
        layer.setStyle(layer._origStyle);
      } else if (layer.setIcon) {
        layer.setIcon(pointIcon(layer._baseColor || '#d6432e'));
      }
    });
    cardHighlightLayers = [];
  }

  function highlightFeature(feature) {
    clearCardHighlight();
    const ids = [feature.id, ...(feature._linkedIds || [])];
    ids.forEach(id => {
      const layer = featureLayerById.get(id);
      if (!layer) return;
      if (layer.setStyle && layer.options && layer.options.fillColor !== undefined) {
        if (!layer._origStyle) {
          layer._origStyle = {
            color: layer.options.color, weight: layer.options.weight,
            opacity: layer.options.opacity, fillOpacity: layer.options.fillOpacity,
            fillColor: layer.options.fillColor
          };
        }
        layer.setStyle({ color: '#D6432E', weight: 4.5, opacity: 1, fillOpacity: Math.max(layer.options.fillOpacity || 0.12, .25) });
        if (layer.bringToFront) layer.bringToFront();
      } else if (layer.setIcon) {
        layer.setIcon(pointIcon('#D6432E'));
      }
      cardHighlightLayers.push(layer);
    });
  }

  function areaFromDescription(text) {
    const m = text.match(/Площадь[^:]*:\s*([\d\s.,]+)\s*кв\.?\s*м/i);
    return m ? m[1].trim().replace(/\s+/g, '') : null;
  }

  function toDisplayUnits(text) {
    return String(text == null ? '' : text).replace(/кв\.?\s*м\b/gi, 'м²');
  }

  window.closeFeatureCard = function closeFeatureCard() {
    cardFeatureId = null;
    cardDragState = null;
    const els = cardEls();
    if (els.card) els.card.classList.add('hidden');
    if (els.lineWrap) els.lineWrap.style.display = 'none';
    clearCardHighlight();
  };

  window.openFeatureCard = function (id) {
    if (activeSection === 'trash') return;
    const feature = findFeature(id);
    if (!feature) { showToast(t('not_found')); return; }
    closePanel();
    cardFeatureId = id;
    
    // Синхронизация описания объединенных объектов (метка + кадастровая зона)
    const linked = (feature._linkedIds || []).map(lid => findFeature(lid)).filter(Boolean);
    const allFeatures = [feature, ...linked];
    const rawDescriptions = allFeatures.map(f => featureText(f.description)).filter(Boolean);
    const combinedDescription = [...new Set(rawDescriptions)].join('\n---\n') || t('no_desc');

    const area = areaFromDescription(combinedDescription);
    const descNoDesignation = combinedDescription.replace(/(<br>)?\s*Назначение\s*:[^<\n]*/gi, '');
    const displayDescription = toDisplayUnits(descNoDesignation);
    const els = cardEls();
    els.title.textContent = feature.name;
    els.body.innerHTML = `
      <div class="feature-card-sub">${escapeHtml(feature.folder)}</div>
      ${area ? `<div class="feature-card-area">${escapeHtml(area)} м²</div>` : ''}
      <div class="feature-card-desc">${escapeHtml(displayDescription)}</div>
      <div class="feature-card-actions">
        <button class="btn btn-primary" type="button" onclick="openRegistryFeature('${feature.id}')">${t('open_card')}</button>
      </div>`;
    const target = projectToScreen(feature.center.lat, feature.center.lng);
    positionCardNear(target);
    els.lineWrap.style.display = 'block';
    highlightFeature(feature);
    updateCardLine();
    map.flyTo([feature.center.lat, feature.center.lng], Math.max(map.getZoom(), feature.geometry.type === 'Point' ? 17 : 16), { duration: .4 });
    map.once('moveend', updateCardLine);
  };

  window.openRegistryFeature = function (id) {
    if (activeSection === 'trash') return;
    closeFeatureCard();
    const feature = findFeature(id);
    if (!feature) { showToast(t('not_found')); return; }

    const linked = (feature._linkedIds || []).map(lid => findFeature(lid)).filter(Boolean);
    const allFeatures = [feature, ...linked];
    const rawDescriptions = allFeatures.map(f => featureText(f.description)).filter(Boolean);
    const combinedDescription = [...new Set(rawDescriptions)].join('\n---\n') || t('no_desc');
    const displayDescription = toDisplayUnits(combinedDescription);

    const pointCoordinates = feature.geometry.type === 'Point'
      ? `${feature.center.lat.toFixed(6)}, ${feature.center.lng.toFixed(6)}`
      : `Центр зоны: ${feature.center.lat.toFixed(6)}, ${feature.center.lng.toFixed(6)}`;
    panelType = 'registry-detail';
    document.getElementById('panel-title').textContent = sectionDefinition().title;
    document.getElementById('panel-body').innerHTML = `
      <div class="detail-address">${escapeHtml(feature.name)}</div>
      <span class="feature-folder">${escapeHtml(feature.folder)}</span>
      <div class="coords-line">📍 ${pointCoordinates}<button class="link-btn" onclick="copyCoords(${feature.center.lat}, ${feature.center.lng})">копировать</button></div>
      <div class="feature-description">${escapeHtml(displayDescription)}</div>
      ${feature.folder === 'Площадки для РВР' ? `
        <div class="tasks-section">
          <div class="tasks-title">Виды работ</div>
          ${Object.entries(feature.tasks || {}).filter(([key, v]) => TASK_LABELS[key] && v !== undefined).map(([key, done]) => `
            <div class="task-row ${done ? 'task-done' : ''}">
              <span class="task-name">${TASK_LABELS[key] || key}</span>
              ${isAdmin ? `
                <button class="btn btn-sm ${done ? 'btn-secondary' : 'btn-primary'}" onclick="toggleTaskDone('${feature.id}', '${key}')">${done ? '✅ Выполнено' : '⏳ Не выполнено'}</button>
                <button class="btn btn-delete-outline btn-sm" style="width:auto; margin-top:0; padding:8px 10px;" onclick="removeTask('${feature.id}', '${key}')" title="Убрать этот вид работы">🗑</button>
              ` : `<span class="task-status">${done ? '✅ Выполнено' : '⏳ Не выполнено'}</span>`}
            </div>
          `).join('') || (isAdmin ? '' : '<div class="task-row" style="opacity:.6">Не назначено</div>')}
          ${isAdmin ? `
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
              ${Object.keys(TASK_LABELS).filter(key => !(feature.tasks && feature.tasks[key] !== undefined)).map(key => `
                <button class="btn btn-ghost btn-sm" onclick="addTask('${feature.id}', '${key}')">+ ${TASK_LABELS[key]}</button>
              `).join('')}
            </div>
          ` : ''}
        </div>
      ` : ''}
      ${isAdmin ? `
        <div class="card-photos-section">
          <div id="registry-photo-slots-${feature.id}">
            <div class="card-photo-slot">
              <div class="card-photo-slot-info">${feature.photo1Url ? '<b>Фото 1</b> загружено' : 'Фото 1 не загружено'}</div>
              <input type="file" id="registry-photo-input-1-${feature.id}" accept="image/*" capture="environment" style="display:none" onchange="uploadRegistryPhoto('${feature.id}', 1, event)">
              <button class="btn btn-secondary btn-sm" id="registry-photo-btn-1-${feature.id}" onclick="document.getElementById('registry-photo-input-1-${feature.id}').click()">${feature.photo1Url ? '🔄 Заменить' : '📤 Загрузить'}</button>
              ${feature.photo1Url ? `<button class="btn btn-delete-outline btn-sm" onclick="deleteRegistryPhotoSlot('${feature.id}', 1)" title="Удалить фото 1">🗑</button>` : ''}
            </div>
            <div class="card-photo-slot">
              <div class="card-photo-slot-info">${feature.photo2Url ? '<b>Фото 2</b> загружено' : 'Фото 2 не загружено'}</div>
              <input type="file" id="registry-photo-input-2-${feature.id}" accept="image/*" capture="environment" style="display:none" onchange="uploadRegistryPhoto('${feature.id}', 2, event)">
              <button class="btn btn-secondary btn-sm" id="registry-photo-btn-2-${feature.id}" onclick="document.getElementById('registry-photo-input-2-${feature.id}').click()">${feature.photo2Url ? '🔄 Заменить' : '📤 Загрузить'}</button>
              ${feature.photo2Url ? `<button class="btn btn-delete-outline btn-sm" onclick="deleteRegistryPhotoSlot('${feature.id}', 2)" title="Удалить фото 2">🗑</button>` : ''}
            </div>
          </div>
          ${(feature.photo1Url || feature.photo2Url) ? `
            <button class="btn btn-secondary" id="registry-show-photos-btn-${feature.id}" style="width:100%; margin-top:10px;" onclick="toggleRegistryPhotos('${feature.id}')">🖼️ Показать фото</button>
            <div class="card-photos-gallery ${(feature.photo1Url && feature.photo2Url) ? '' : 'single-photo'}" id="registry-photos-gallery-${feature.id}"></div>
          ` : ''}
        </div>
      ` : ''}
      <div class="detail-meta">ID объекта: ${escapeHtml(feature.id)}<br>Тип: ${feature.geometry.type === 'Point' ? 'площадка / точка' : 'зона ответственности'}</div>
      <button class="btn btn-primary" style="width:100%; margin-top:22px" onclick="editRegistryFeature('${feature.id}')">${t('edit_btn')}</button>
      <button class="btn btn-delete-outline" onclick="deleteRegistryFeature('${feature.id}')">${t('delete_btn')}</button>`;
    document.getElementById('panel').classList.add('open');
    document.getElementById('backdrop').classList.add('show');
    map.flyTo([feature.center.lat, feature.center.lng], Math.max(map.getZoom(), feature.geometry.type === 'Point' ? 17 : 15), { duration: .45 });
  };

  // ── Фото карточки адреса (до 2 шт., та же схема что у точек вывоза:
  // сжатие в WebP на устройстве + Firebase Storage + подгрузка по клику) ──
  window.uploadRegistryPhoto = async function (featureId, slot, event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    if (typeof STORAGE_BUCKET_AVAILABLE === 'undefined' || !STORAGE_BUCKET_AVAILABLE || !FIRESTORE_AVAILABLE) {
      showToast('Firebase Storage/Firestore не настроены — фото не может быть загружено');
      return;
    }

    const btn = document.getElementById(`registry-photo-btn-${slot}-${featureId}`);
    const originalLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Загрузка…'; }

    try {
      const blob = await compressToWebp(file, CARD_PHOTO_MAX_DIM, CARD_PHOTO_TARGET_BYTES);
      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
      const otherExt = ext === 'webp' ? 'jpg' : 'webp';
      const basePath = `registry-photos/${activeSection}/${featureId}/photo${slot}`;

      firebase.storage().ref(`${basePath}.${otherExt}`).delete().catch(() => {});

      const ref = firebase.storage().ref(`${basePath}.${ext}`);
      await ref.put(blob, { contentType: blob.type, cacheControl: 'public, max-age=31536000, immutable' });
      const url = await ref.getDownloadURL();

      const field = slot === 1 ? 'photo1Url' : 'photo2Url';
      await saveFeatureOverride(activeSection, featureId, { [field]: url });
      showToast('Фото сохранено ✅');
      openRegistryFeature(featureId);
    } catch (err) {
      console.error(err);
      showToast(err && err.code === 'storage/unauthorized'
        ? 'Нет доступа к Storage — проверьте правила безопасности'
        : 'Не удалось загрузить фото. Проверьте план Firebase (нужен Blaze) и подключение');
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
  };

  window.toggleRegistryPhotos = function (featureId) {
    const gallery = document.getElementById(`registry-photos-gallery-${featureId}`);
    const btn = document.getElementById(`registry-show-photos-btn-${featureId}`);
    const slots = document.getElementById(`registry-photo-slots-${featureId}`);
    if (!gallery || !btn) return;

    if (gallery.classList.contains('show')) {
      gallery.classList.remove('show');
      btn.textContent = '🖼️ Показать фото';
      if (slots) slots.style.display = '';
      return;
    }

    if (!gallery.dataset.loaded) {
      const feature = findFeature(featureId);
      const urls = feature ? [feature.photo1Url, feature.photo2Url].filter(Boolean) : [];
      gallery.innerHTML = urls.map(u => `<img src="${u}" alt="Фото объекта" loading="lazy">`).join('');
      gallery.dataset.loaded = '1';
    }
    gallery.classList.add('show');
    btn.textContent = '🙈 Скрыть фото';
    if (slots) slots.style.display = 'none';
  };

  window.deleteRegistryPhotoSlot = async function (featureId, slot) {
    if (!confirm('Удалить это фото?')) return;
    const field = slot === 1 ? 'photo1Url' : 'photo2Url';
    const basePath = `registry-photos/${activeSection}/${featureId}/photo${slot}`;
    try {
      if (typeof STORAGE_BUCKET_AVAILABLE !== 'undefined' && STORAGE_BUCKET_AVAILABLE) {
        await Promise.all([
          firebase.storage().ref(`${basePath}.webp`).delete().catch(() => {}),
          firebase.storage().ref(`${basePath}.jpg`).delete().catch(() => {})
        ]);
      }
      await saveFeatureOverride(activeSection, featureId, { [field]: null });
      const gallery = document.getElementById(`registry-photos-gallery-${featureId}`);
      if (gallery) gallery.dataset.loaded = ''; // перегрузить галерею при следующем показе
      showToast('Фото удалено');
      openRegistryFeature(featureId);
    } catch (err) {
      console.error(err);
      showToast('Не удалось удалить фото');
    }
  };

  // ── Виды работ (только площадки РВР) — выполнено/не выполнено ──
  window.toggleTaskDone = async function (featureId, taskKey) {
    const feature = findFeature(featureId);
    if (!feature || !feature.tasks) return;
    const updatedTasks = { ...feature.tasks, [taskKey]: !feature.tasks[taskKey] };
    try {
      await saveFeatureOverride(activeSection, featureId, { tasks: updatedTasks });
      openRegistryFeature(featureId);
      if (typeof refreshTaskFilterHighlight === 'function') refreshTaskFilterHighlight();
    } catch (err) {
      console.error(err);
      showToast('Не удалось сохранить статус работы');
    }
  };

  window.addTask = async function (featureId, taskKey) {
    const feature = findFeature(featureId);
    if (!feature) return;
    const updatedTasks = { ...(feature.tasks || {}), [taskKey]: false }; // false = не выполнено
    try {
      await saveFeatureOverride(activeSection, featureId, { tasks: updatedTasks });
      openRegistryFeature(featureId);
      if (typeof refreshTaskFilterHighlight === 'function') refreshTaskFilterHighlight();
    } catch (err) {
      console.error(err);
      showToast('Не удалось добавить вид работы');
    }
  };

  window.removeTask = async function (featureId, taskKey) {
    const feature = findFeature(featureId);
    if (!feature || !feature.tasks) return;
    const updatedTasks = { ...feature.tasks };
    delete updatedTasks[taskKey];

    // Обновляем локальный кэш правок (как это делает saveFeatureOverride) —
    // но для самого Firestore тут нужно явное удаление поля через
    // FieldValue.delete(), потому что set({..}, {merge:true}) с вложенным
    // объектом НЕ удаляет ключи, которые в нём просто отсутствуют, —
    // он только домешивает то, что прислано, не трогая остальное.
    const sectionKey = activeSection;
    const current = storedFeatureOverrides[sectionKey].get(featureId) || {};
    const combined = { ...current, tasks: updatedTasks };
    storedFeatureOverrides[sectionKey].set(featureId, combined);
    saveLocalOverrides(sectionKey);

    try {
      if (FIRESTORE_AVAILABLE && persistenceMode[sectionKey] === 'firebase') {
        await db.collection(sections[sectionKey].collection).doc(featureId)
          .update({ [`tasks.${taskKey}`]: firebase.firestore.FieldValue.delete() });
      }
      openRegistryFeature(featureId);
      if (typeof refreshTaskFilterHighlight === 'function') refreshTaskFilterHighlight();
    } catch (err) {
      console.error(err);
      showToast('Не удалось убрать вид работы');
    }
  };

  function parseCadastreFields(description) {
    const text = featureText(description);
    const cadastreMatch = text.match(/Кадастровый номер:\s*([^\n]+)/i);
    const areaMatch = text.match(/Площадь[^:]*:\s*([\d\s.,]+)\s*(?:кв\.?\s*м|м²)/i);
    const cadastre = cadastreMatch ? cadastreMatch[1].trim() : '';
    const area = areaMatch ? areaMatch[1].trim().replace(/\s+/g, '') : '';
    // Strip those lines from free-text description
    const freeText = text
      .replace(/Кадастровый номер:\s*[^\n]+\n?/gi, '')
      .replace(/Площадь[^:]*:\s*[\d\s.,]+\s*(?:кв\.?\s*м|м²)[^\n]*\n?/gi, '')
      .trim();
    return { cadastre, area, freeText };
  }

  function buildDescriptionFromFields(cadastre, area, freeText) {
    const parts = [];
    if (cadastre.trim()) parts.push(`Кадастровый номер: ${cadastre.trim()}`);
    if (area.trim()) parts.push(`Площадь из отчета: ${area.trim()} кв.м`);
    if (freeText.trim()) parts.push(freeText.trim());
    return parts.join('\n');
  }

  function categoryOptionsHtml(currentFolder, sectionKey) {
    const cats = sectionKey === 'repair'
      ? ['Площадки для РВР']
      : ['Кадастровые границы', 'Детские площадки', 'Административные сектора', 'Без категории'];
    return cats.map(c =>
      `<option value="${escapeHtml(c)}" ${c === currentFolder ? 'selected' : ''}>${escapeHtml(c)}</option>`
    ).join('');
  }

  window.editRegistryFeature = function (id) {
    const feature = findFeature(id);
    if (!feature) return;
    const isPoint = feature.geometry.type === 'Point';
    const { cadastre, area, freeText } = parseCadastreFields(feature.description);
    panelType = 'registry-edit';
    document.getElementById('panel-title').textContent = t('edit_title');
    document.getElementById('panel-body').innerHTML = `
      <label class="field-label">${t('name_label')}</label>
      <input id="registry-name" class="field-input" value="${escapeHtml(feature.name)}">
      <label class="field-label">${t('category_label')}</label>
      <select id="registry-category" class="field-input">${categoryOptionsHtml(feature.folder, activeSection)}</select>
      ${isPoint ? `
      <label class="field-label">${t('lat_label')}</label>
      <input id="registry-lat" class="field-input" inputmode="decimal" value="${feature.center.lat}">
      <label class="field-label">${t('lng_label')}</label>
      <input id="registry-lng" class="field-input" inputmode="decimal" value="${feature.center.lng}">
      ` : `<div class="detail-comment muted">${t('zone_hint')}</div>`}
      <label class="field-label">${t('cadastre_label')}</label>
      <input id="registry-cadastre" class="field-input" value="${escapeHtml(cadastre)}" placeholder="09-145-007-493">
      <label class="field-label">${t('area_label')}</label>
      <input id="registry-area" class="field-input" inputmode="decimal" value="${escapeHtml(area)}" placeholder="58748">
      <label class="field-label">${t('desc_label')}</label>
      <textarea id="registry-description" class="field-input" rows="5">${escapeHtml(freeText)}</textarea>
      <div class="panel-actions">
        <button class="btn btn-secondary" onclick="openRegistryFeature('${feature.id}')">${t('cancel_btn')}</button>
        <button class="btn btn-primary" onclick="saveRegistryFeature('${feature.id}')">${t('save_btn')}</button>
      </div>`;
  };

  window.saveRegistryFeature = async function (id) {
    const feature = findFeature(id);
    if (!feature) return;
    const name = document.getElementById('registry-name').value.trim();
    const cadastre = (document.getElementById('registry-cadastre') || {}).value || '';
    const area = (document.getElementById('registry-area') || {}).value || '';
    const freeText = document.getElementById('registry-description').value.trim();
    const folder = (document.getElementById('registry-category') || {}).value || feature.folder;
    if (!name) { showToast(t('no_name_toast')); return; }
    const description = buildDescriptionFromFields(cadastre, area, freeText);
    const change = { name, description, folder, deleted: false, updatedAt: new Date().toISOString() };
    if (feature.geometry.type === 'Point') {
      const lat = Number(document.getElementById('registry-lat').value.replace(',', '.'));
      const lng = Number(document.getElementById('registry-lng').value.replace(',', '.'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        showToast(t('check_coords_toast')); return;
      }
      change.geometry = { type: 'Point', coordinates: { lat, lng } };
    }
    await saveFeatureOverride(activeSection, id, change);
    showToast(t('saved_toast'));
    renderRegistryLayer();
    window.openRegistryFeature(id);
  };

  window.deleteRegistryFeature = async function (id) {
    const feature = findFeature(id);
    if (!feature || !confirm(`${t('delete_confirm')} «${feature.name}» ${t('delete_from_map')}?`)) return;
    await saveFeatureOverride(activeSection, id, { deleted: true, updatedAt: new Date().toISOString() });
    closePanel();
    renderRegistryLayer();
    showToast(t('deleted_toast'));
  };

  // ── Добавление новой точки ────────────────────────────────────────────────

  let addPointPickingCoords = false;

  window.openAddPointPanel = function () {
    panelType = 'registry-add';
    document.getElementById('panel-title').textContent = t('add_point_title');
    document.getElementById('panel-body').innerHTML = `
      <label class="field-label">${t('name_label')}</label>
      <input id="new-point-name" class="field-input" placeholder="ул. Димитрова 12">
      <label class="field-label">${t('category_label')}</label>
      <select id="new-point-category" class="field-input">${categoryOptionsHtml('', activeSection)}</select>
      <label class="field-label">${t('lat_label')}</label>
      <input id="new-point-lat" class="field-input" inputmode="decimal" placeholder="50.0620">
      <label class="field-label">${t('lng_label')}</label>
      <input id="new-point-lng" class="field-input" inputmode="decimal" placeholder="72.9800">
      <button class="btn btn-secondary" style="width:100%;margin-bottom:8px" onclick="startPickCoords()">${t('click_map_hint')}</button>
      <label class="field-label">${t('cadastre_label')}</label>
      <input id="new-point-cadastre" class="field-input" placeholder="09-145-007-493">
      <label class="field-label">${t('area_label')}</label>
      <input id="new-point-area" class="field-input" inputmode="decimal" placeholder="58748">
      <label class="field-label">${t('desc_label')}</label>
      <textarea id="new-point-description" class="field-input" rows="4"></textarea>
      <div class="panel-actions">
        <button class="btn btn-secondary" onclick="closePanel()">${t('cancel_btn')}</button>
        <button class="btn btn-primary" onclick="saveNewPoint()">${t('save_btn')}</button>
      </div>`;
    document.getElementById('panel').classList.add('open');
    document.getElementById('backdrop').classList.add('show');
  };


  // "Добавить точку привязанную к зоне" — открывается из карточки зоны
  window.openAddPointFromZone = function (featureId) {
    const feature = findFeature(featureId);
    const { cadastre, area, freeText } = parseCadastreFields(feature ? feature.description : '');
    const folder = feature ? feature.folder : 'Без категории';
    panelType = 'registry-add';
    document.getElementById('panel-title').textContent = t('add_point_title');
    document.getElementById('panel-body').innerHTML = `
      <div style="background:var(--surface-deep);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--text-mut)">
        📎 Точка привязана к зоне: <b>${escapeHtml(feature ? feature.name : '')}</b>
      </div>
      <label class="field-label">${t('name_label')}</label>
      <input id="new-point-name" class="field-input" value="${escapeHtml(feature ? feature.name : '')}">
      <label class="field-label">${t('category_label')}</label>
      <select id="new-point-category" class="field-input">${categoryOptionsHtml(folder, activeSection)}</select>
      <label class="field-label">${t('lat_label')}</label>
      <input id="new-point-lat" class="field-input" inputmode="decimal" value="${feature ? feature.center.lat.toFixed(6) : ''}">
      <label class="field-label">${t('lng_label')}</label>
      <input id="new-point-lng" class="field-input" inputmode="decimal" value="${feature ? feature.center.lng.toFixed(6) : ''}">
      <button class="btn btn-secondary" style="width:100%;margin-bottom:8px" onclick="startPickCoords()">${t('click_map_hint')}</button>
      <label class="field-label">${t('cadastre_label')}</label>
      <input id="new-point-cadastre" class="field-input" value="${escapeHtml(cadastre)}">
      <label class="field-label">${t('area_label')}</label>
      <input id="new-point-area" class="field-input" inputmode="decimal" value="${escapeHtml(area)}">
      <label class="field-label">${t('desc_label')}</label>
      <textarea id="new-point-description" class="field-input" rows="4">${escapeHtml(freeText)}</textarea>
      <div class="panel-actions">
        <button class="btn btn-secondary" onclick="openRegistryFeature('${featureId}')">${t('cancel_btn')}</button>
        <button class="btn btn-primary" onclick="saveNewPoint()">${t('save_btn')}</button>
      </div>`;
    document.getElementById('panel').classList.add('open');
    document.getElementById('backdrop').classList.add('show');
  };

  window.startPickCoords = function () {
    addPointPickingCoords = true;
    showToast(t('click_map_hint'));
    document.getElementById('panel').classList.remove('open');
    document.getElementById('backdrop').classList.remove('show');
    map.getContainer().style.cursor = 'crosshair';
  };

  window.handleRegistryMapClick = function (latlng) {
    if (!isAdmin) return;
    if (addPointPickingCoords) {
      addPointPickingCoords = false;
      map.getContainer().style.cursor = '';
      // Заполнить координаты и снова открыть панель
      panelType = 'registry-add';
      document.getElementById('panel').classList.add('open');
      document.getElementById('backdrop').classList.add('show');
      const latEl = document.getElementById('new-point-lat');
      const lngEl = document.getElementById('new-point-lng');
      if (latEl) latEl.value = latlng.lat.toFixed(6);
      if (lngEl) lngEl.value = latlng.lng.toFixed(6);
      return;
    }
    // Обычный клик по карте — ничего не делаем в режиме реестра
  };

  window.saveNewPoint = async function () {
    const name = (document.getElementById('new-point-name').value || '').trim();
    const folder = document.getElementById('new-point-category').value || 'Без категории';
    const latRaw = (document.getElementById('new-point-lat').value || '').replace(',', '.');
    const lngRaw = (document.getElementById('new-point-lng').value || '').replace(',', '.');
    const cadastre = (document.getElementById('new-point-cadastre').value || '').trim();
    const area = (document.getElementById('new-point-area').value || '').trim();
    const freeText = (document.getElementById('new-point-description').value || '').trim();

    if (!name) { showToast(t('no_name_toast')); return; }
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || lat === 0) {
      showToast(t('check_coords_toast')); return;
    }

    const description = buildDescriptionFromFields(cadastre, area, freeText);
    const id = 'new_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const newFeature = {
      id,
      name,
      folder,
      description,
      geometry: { type: 'Point', coordinates: { lat, lng } },
      style: {},
      deleted: false,
      isNew: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Добавляем в локальный массив данных секции
    sections[activeSection].data.push(newFeature);
    // Сохраняем override в Firestore (или localStorage)
    await saveFeatureOverride(activeSection, id, newFeature);

    closePanel();
    renderRegistryLayer();
    showToast(t('add_point_toast'));
    // Открываем карточку новой точки
    setTimeout(() => window.openRegistryFeature(id), 300);
  };


  // ── Добавление новой зоны (рисование полигона) ───────────────────────────

  // Цвета по категории
  const CATEGORY_COLORS = {
    'Кадастровые границы':      '#00ff00',   // салатовый (скрин 1)
    'Детские площадки':         '#00ff00',   // салатовый (скрин 1)
    'Административные сектора': '#347beb',   // синий (скрин 2)
    'Площадки для РВР':         '#9c27b0',   // фиолетовый (РВР)
    'Кадастровые Зоны':         '#a52714',   // красный (РВР)
    'Temirtau_Sektora.kml':     '#347beb',   // синий как сектора
    'Без категории':            '#555'
  };
  function colorForCategory(folder) {
    return CATEGORY_COLORS[folder] || sectionDefinition().markerColor || '#1f7a5a';
  }

    let zoneDrawing = false;
  let zoneVertices = [];
  let zonePreviewLayer = null;
  let zoneVertexMarkers = [];

  function zoneToolbarSync() {
    var tb = document.getElementById('zone-draw-toolbar');
    var cnt = document.getElementById('zdtb-count');
    var btn = document.getElementById('zdtb-finish');
    if (!tb) return;
    if (zoneDrawing) {
      tb.classList.add('active');
      if (cnt) cnt.textContent = zoneVertices.length;
      if (btn) btn.disabled = zoneVertices.length < 3;
    } else {
      tb.classList.remove('active');
    }
  }

  function zoneDrawCleanup() {
    zoneDrawing = false;
    zoneVertices = [];
    map.getContainer().style.cursor = '';
    document.body.classList.remove('zone-drawing');
    if (zonePreviewLayer) { featureLayer.removeLayer(zonePreviewLayer); zonePreviewLayer = null; }
    zoneVertexMarkers.forEach(m => featureLayer.removeLayer(m));
    zoneVertexMarkers = [];
    zoneToolbarSync();
  }

  window.zoneDrawUndo = function () {
    if (!zoneVertices.length) return;
    zoneVertices.pop();
    var dot = zoneVertexMarkers.pop();
    if (dot) featureLayer.removeLayer(dot);
    zoneDrawUpdatePreview();
    zoneToolbarSync();
  };

  function zoneDrawUpdatePreview() {
    if (zonePreviewLayer) featureLayer.removeLayer(zonePreviewLayer);
    if (zoneVertices.length < 2) { zonePreviewLayer = null; return; }
    const catEl = document.getElementById('new-zone-category');
    const folder = catEl ? catEl.value : 'Кадастровые границы';
    const color = colorForCategory(folder);
    zonePreviewLayer = L.polygon(
      zoneVertices.map(v => [v.lat, v.lng]),
      { color, weight: 2.5, opacity: 1, fillColor: color, fillOpacity: 0.22, dashArray: '7,5' }
    );
    featureLayer.addLayer(zonePreviewLayer);
    // Перекрашиваем вершинные маркеры под новый цвет
    zoneVertexMarkers.forEach(m => m.setStyle({ fillColor: color }));
  }

  function zoneDrawAddVertex(latlng) {
    zoneVertices.push({ lat: latlng.lat, lng: latlng.lng });
    const catEl = document.getElementById('new-zone-category');
    const folder = catEl ? catEl.value : 'Кадастровые границы';
    const color = colorForCategory(folder);
    const dot = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1
    });
    featureLayer.addLayer(dot);
    zoneVertexMarkers.push(dot);
    zoneDrawUpdatePreview();
    zoneToolbarSync();  // ← обновляет счётчик в тулбаре внизу
    // старый элемент в панели (если вдруг открыта)
    const hint = document.getElementById('zone-draw-status');
    if (hint) hint.textContent = t('draw_zone_active') + zoneVertices.length;
    const finBtn = document.getElementById('zone-finish-btn');
    if (finBtn) finBtn.disabled = zoneVertices.length < 3;
  }

  window.openAddZonePanel = function () {
    zoneDrawCleanup();
    panelType = 'registry-add-zone';
    document.getElementById('panel-title').textContent = t('add_zone_title');
    document.getElementById('panel-body').innerHTML =
      '<label class="field-label">' + t('name_label') + '</label>' +
      '<input id="new-zone-name" class="field-input" placeholder="">' +
      '<label class="field-label">' + t('category_label') + '</label>' +
      '<select id="new-zone-category" class="field-input">' + categoryOptionsHtml('Кадастровые границы', activeSection) + '</select>' +
      '<label class="field-label">' + t('cadastre_label') + '</label>' +
      '<input id="new-zone-cadastre" class="field-input" placeholder="09-145-007-493">' +
      '<label class="field-label">' + t('area_label') + '</label>' +
      '<input id="new-zone-area" class="field-input" inputmode="decimal" placeholder="58748">' +
      '<label class="field-label">' + t('desc_label') + '</label>' +
      '<textarea id="new-zone-description" class="field-input" rows="3"></textarea>' +
      '<div style="background:var(--surface-deep);border-radius:10px;padding:12px;margin-top:8px;font-size:13px;color:var(--muted)">' + t('draw_zone_hint') + '</div>' +
      '<div class="panel-actions" style="margin-top:12px">' +
        '<button class="btn btn-secondary" onclick="cancelZoneDraw()">' + t('draw_zone_cancel') + '</button>' +
        '<button class="btn btn-primary" id="zone-finish-btn" onclick="finishZoneDraw()" disabled>' + t('draw_zone_finish') + '</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:14px;padding:12px;background:var(--surface-deep);border-radius:10px">' +
      '<input type="checkbox" id="new-zone-add-point" style="width:18px;height:18px;cursor:pointer">' +
      '<label for="new-zone-add-point" style="font-size:13px;cursor:pointer;line-height:1.4">Сразу добавить точку по центру зоны</label>' +
      '</div>' +
      '<div id="zone-draw-status" style="text-align:center;font-size:13px;color:var(--brand);margin-top:8px;font-weight:600"></div>';
    document.getElementById('panel').classList.add('open');
    // Не показываем backdrop — чтобы карта оставалась кликабельной
    document.body.classList.add('zone-drawing');
    zoneDrawing = true;
    map.getContainer().style.cursor = 'crosshair';
    zoneToolbarSync();
    showToast(t('draw_zone_hint'));
  };

  window.cancelZoneDraw = function () {
    zoneDrawCleanup();
    closePanel();
    renderRegistryLayer();
  };

  window.finishZoneDraw = async function () {
    if (zoneVertices.length < 3) { showToast(t('draw_zone_min')); return; }
    const nameEl = document.getElementById('new-zone-name');
    const name = nameEl ? nameEl.value.trim() : '';
    const folderEl = document.getElementById('new-zone-category');
    const folder = folderEl ? folderEl.value : 'Кадастровые границы';
    const cadastreEl = document.getElementById('new-zone-cadastre');
    const cadastre = cadastreEl ? cadastreEl.value.trim() : '';
    const areaEl = document.getElementById('new-zone-area');
    const area = areaEl ? areaEl.value.trim() : '';
    const descEl = document.getElementById('new-zone-description');
    const freeText = descEl ? descEl.value.trim() : '';
    if (!name) { showToast(t('no_name_toast')); return; }

    const description = buildDescriptionFromFields(cadastre, area, freeText);
    const id = 'new_zone_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const color = colorForCategory(folder);
    const newFeature = {
      id,
      name,
      folder,
      description,
      geometry: { type: 'Polygon', coordinates: [zoneVertices.map(v => ({ lat: v.lat, lng: v.lng }))] },
      style: { color, fillColor: color, opacity: 0.9, fillOpacity: 0.12, weight: 2 },
      deleted: false,
      isNew: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const addPointCheck = document.getElementById('new-zone-add-point');
    const shouldAddPoint = addPointCheck && addPointCheck.checked;
    const savedVerts = zoneVertices.slice();

    zoneDrawCleanup();
    sections[activeSection].data.push(newFeature);
    await saveFeatureOverride(activeSection, id, newFeature);

    if (shouldAddPoint && savedVerts.length >= 3) {
      const centerLat = savedVerts.reduce(function(a,v){return a+v.lat;},0) / savedVerts.length;
      const centerLng = savedVerts.reduce(function(a,v){return a+v.lng;},0) / savedVerts.length;
      const ptId = 'new_pt_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
      const ptFeature = {
        id: ptId, name: name, folder: folder, description: description,
        geometry: { type: 'Point', coordinates: { lat: centerLat, lng: centerLng } },
        style: { color: color }, deleted: false, isNew: true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      sections[activeSection].data.push(ptFeature);
      await saveFeatureOverride(activeSection, ptId, ptFeature);
    }

    closePanel();
    renderRegistryLayer();
    showToast(t('add_zone_toast'));
    setTimeout(function() { window.openRegistryFeature(id); }, 300);
  };

  // ── Пространственный поиск: точка внутри полигона (ray-casting) ──────────
  function _rayInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lat, yi = ring[i].lng;
      const xj = ring[j].lat, yj = ring[j].lng;
      if (((yi > lng) !== (yj > lng)) &&
          (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function _pointInFeature(lat, lng, feature) {
    const geo = feature.geometry;
    if (geo.type === 'Polygon') return _rayInRing(lat, lng, geo.coordinates[0]);
    if (geo.type === 'MultiPolygon') return geo.coordinates.some(ring => _rayInRing(lat, lng, ring));
    return false;
  }

  // Все полигоны микрорайонов/кварталов из раздела «Ремонтные работы»
  function getMicrodistrictPolygons() {
    return getFeatures('repair').filter(f =>
      isMicrorayonSector(f) && f.geometry.type !== 'Point'
    );
  }

  // Разгруппировать адреса по микрорайону через point-in-polygon
  function buildGroupsByMicrodistrict(features) {
    const polys = getMicrodistrictPolygons();
    polys.sort((a, b) => {
      const am = /^мкр/i.test(a.name) ? 0 : 1;
      const bm = /^мкр/i.test(b.name) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name, 'ru');
    });

    const groups = new Map();
    const polyOrder = polys.map(p => p.name);
    const unassigned = [];

    features.forEach(feature => {
      if (!feature.center) return;
      const { lat, lng } = feature.center;
      let assigned = false;
      for (const poly of polys) {
        if (_pointInFeature(lat, lng, poly)) {
          const key = poly.name;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(feature);
          assigned = true;
          break;
        }
      }
      if (!assigned) unassigned.push(feature);
    });

    const ordered = new Map();
    polyOrder.forEach(name => { if (groups.has(name)) ordered.set(name, groups.get(name)); });
    if (unassigned.length) ordered.set('Прочие / вне границ', unassigned);
    return ordered;
  }

  const _mikrGroupRegistry = new Map();

  // ── Окно копирования адресов ──────────────────────────────────────────────
  window.openAddressCopyModal = function (groupKey) {
    const entry = _mikrGroupRegistry.get(groupKey);
    if (!entry) return;
    const text = entry.items.map(i => i.name).join('\n');
    const titleEl = document.getElementById('addr-modal-title');
    if (titleEl) titleEl.textContent = `${entry.mikrName} (${entry.items.length})`;
    const ta = document.getElementById('addr-modal-text');
    if (ta) ta.value = text;
    const modal = document.getElementById('addr-modal');
    if (modal) {
      modal.classList.add('open');
      modal.classList.remove('hidden');
    }
    if (ta) { ta.focus(); ta.select(); }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast(`${t('copied_toast').replace('Мекенжайлар', `Мекенжайлар (${entry.items.length})`).replace('Адреса скопированы', `Адреса (${entry.items.length}) скопированы`)}`))
        .catch(() => {});
    }
  };

  window.closeAddressCopyModal = function () {
    const modal = document.getElementById('addr-modal');
    if (modal) {
      modal.classList.remove('open');
      modal.classList.add('hidden');
    }
  };

  window.copyAddressModalText = function () {
    const ta = document.getElementById('addr-modal-text');
    if (!ta) return;
    ta.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value)
        .then(() => showToast(t('copied_toast')))
        .catch(() => { document.execCommand('copy'); showToast(t('copied_toast')); });
    } else {
      document.execCommand('copy');
      showToast(t('copied_toast'));
    }
  };

  // ── Копирование ВСЕХ адресов реестра ─────────────────────────────────────
  window.copyAllRegistryAddresses = function () {
    const activeFeats = getFeatures(activeSection);
    const pool = activeFeats.length ? activeFeats : [...getFeatures('gis'), ...getFeatures('repair')];
    const features = pool.filter(f => f.geometry && (f.geometry.type === 'Point' || f.geometry.type === 'Polygon') && !isMicrorayonSector(f));
    const uniqueNames = Array.from(new Set(features.map(f => f.name.trim()).filter(Boolean)));
    if (!uniqueNames.length) {
      showToast(t('no_addresses_toast'));
      return;
    }

    const text = uniqueNames.join('\n');
    const titleEl = document.getElementById('addr-modal-title');
    if (titleEl) titleEl.textContent = `${t('all_registry_addr')} (${uniqueNames.length})`;
    const ta = document.getElementById('addr-modal-text');
    if (ta) ta.value = text;
    
    const modal = document.getElementById('addr-modal');
    if (modal) {
      modal.classList.add('open');
      modal.classList.remove('hidden');
    }
    if (ta) { ta.focus(); ta.select(); }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast(`${t('all_copied_toast')} (${uniqueNames.length})`))
        .catch(() => { document.execCommand('copy'); showToast(t('all_copied_toast')); });
    } else {
      document.execCommand('copy');
      showToast(t('all_copied_toast'));
    }
  };

  // ── Маршрут по дворам (Google Maps Directions) ────────────────────────────
  window.openYardRoute = function (groupKey) {
    const entry = _mikrGroupRegistry.get(groupKey);
    const pts = entry ? entry.points : [];
    if (!pts.length) return;
    if (pts.length === 1) {
      window.open(`https://www.google.com/maps/search/?api=1&query=${pts[0].lat},${pts[0].lng}`, '_blank');
      return;
    }
    const origin = `${pts[0].lat},${pts[0].lng}`;
    const dest   = `${pts[pts.length - 1].lat},${pts[pts.length - 1].lng}`;
    const wpts   = pts.slice(1, -1).slice(0, 8).map(p => `${p.lat},${p.lng}`).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=walking`;
    if (wpts) url += `&waypoints=${encodeURIComponent(wpts)}`;
    window.open(url, '_blank');
  };

  function groupFeatures(features) {
    return features.reduce((groups, feature) => {
      (groups[feature.folder] ||= []).push(feature);
      return groups;
    }, {});
  }

  function renderCatalog(query = '') {
    const needle = query.trim().toLowerCase();

    // Объединяем адреса и оставляем только действительные объекты с географическими точками/зонами
    const activeFeats = getFeatures(activeSection);
    const pool = activeFeats.length ? activeFeats : [...getFeatures('gis'), ...getFeatures('repair')];
    const allFeatures = pool.filter(f => f.geometry && (f.geometry.type === 'Point' || f.geometry.type === 'Polygon') && !isMicrorayonSector(f));

    const features = needle
      ? allFeatures.filter(f =>
          [f.name, f.folder, featureText(f.description), f.id]
            .join(' ').toLowerCase().includes(needle))
      : allFeatures;

    const groups = buildGroupsByMicrodistrict(features);

    // Регистрируем данные групп под безопасными ключами
    _mikrGroupRegistry.clear();
    const list = features.length
      ? Array.from(groups.entries()).map(([mikrName, items]) => {
          const groupKey = 'grp_' + mikrName.replace(/\W/g, '_');
          _mikrGroupRegistry.set(groupKey, {
            mikrName,
            items,
            points: items.map(i => ({ lat: i.center.lat, lng: i.center.lng, name: i.name }))
          });
          const displayMikrName = currentLang === 'kk' ? translateToKazakh(mikrName) : mikrName;
          return `
            <div class="mikr-group">
              <div class="mikr-group-header">
                <span class="list-section-title" style="margin:0">${escapeHtml(displayMikrName)} <span class="mikr-count">${items.length}</span></span>
                <div class="mikr-btns">
                  <button class="mikr-btn mikr-btn-copy" title="${t('copy_district_addresses')}"
                    onclick="openAddressCopyModal('${groupKey}')">📋</button>
                  <button class="mikr-btn mikr-btn-route" title="${t('route_yards')}"
                    onclick="openYardRoute('${groupKey}')">🗺</button>
                </div>
              </div>
              <div class="history-list">
                ${items.map(f => `
                  <div class="history-item" data-feature-id="${f.id}">
                    <div class="history-item-address">${escapeHtml(currentLang === 'kk' ? translateToKazakh(f.name) : f.name)}</div>
                    <div class="history-item-date history-item-source">${escapeHtml(currentLang === 'kk' ? translateToKazakh(f.folder) : f.folder)}</div>
                  </div>`).join('')}
              </div>
            </div>`;
        }).join('')
      : `<div class="empty-state">${t('nothing_found')}</div>`;

    document.getElementById('panel-body').innerHTML = `
      <div class="history-counter">
        <div class="big-num">${features.length}</div>
        <div class="counter-label">${t('addresses_in_registry')}</div>
        <button class="btn btn-primary" style="margin-top:12px; width:100%; display:flex; align-items:center; justify-content:center; gap:8px;" onclick="copyAllRegistryAddresses()">
          ${t('copy_all_addresses')} (${features.length})
        </button>
        ${isAdmin ? `
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-secondary" style="flex:1" onclick="openAddPointPanel()">${t('add_point_btn')}</button>
          <button class="btn btn-secondary" style="flex:1" onclick="openAddZonePanel()">${t('add_zone_btn')}</button>
        </div>` : ''}
      </div>
      <input id="registry-list-search" class="field-input" placeholder="${t('search_by_address')}" value="${escapeHtml(query)}">
      <div id="registry-catalog">${list}</div>`;

    document.getElementById('registry-list-search')
      .addEventListener('input', e => renderCatalog(e.target.value));
    document.querySelectorAll('[data-feature-id]')
      .forEach(item => item.addEventListener('click', () => window.openFeatureCard(item.dataset.featureId)));
  }

  function openCurrentCatalog() {
    if (activeSection === 'trash') {
      // Кнопка была пересоздана, поэтому вызываем исходную функцию явно.
      return window.openTrashHistory();
    }
    closeFeatureCard();
    panelType = 'registry-list';
    document.getElementById('panel-title').textContent = `${t('objects_label')}: ${sectionDefinition().title}`;
    document.getElementById('panel').classList.add('open');
    document.getElementById('backdrop').classList.add('show');
    renderCatalog();
  }

  function runSearch() {
    if (activeSection === 'trash') return originalHandleSearch();
    const query = document.getElementById('search-input').value.trim();
    if (!query) { openCurrentCatalog(); return; }
    const needle = query.toLowerCase();
    const matches = getFeatures(activeSection).filter(feature => [feature.name, feature.folder, featureText(feature.description), feature.id, `${feature.center.lat},${feature.center.lng}`].join(' ').toLowerCase().includes(needle));
    if (matches.length === 1) { window.openFeatureCard(matches[0].id); return; }
    if (matches.length > 1) {
      closeFeatureCard();
      panelType = 'registry-list';
      document.getElementById('panel-title').textContent = `${t('found')}: ${matches.length}`;
      document.getElementById('panel').classList.add('open');
      document.getElementById('backdrop').classList.add('show');
      renderCatalog(query);
      return;
    }
    // В реестре текущего раздела ничего не нашли — обычный адресный поиск,
    // как во вкладке «Вывоз мусора» (дома, ТЦ, координаты, Nominatim)
    return originalHandleSearch();
  }

  window.findNearbyFeature = function (lat, lon) {
    if (activeSection === 'trash' || !window.haversineMeters) return null;
    const feats = getFeatures(activeSection);
    let best = null, bestDist = Infinity;
    for (const f of feats) {
      if (!f.center) continue;
      const d = window.haversineMeters(lat, lon, f.center.lat, f.center.lng);
      if (d < bestDist) { bestDist = d; best = f; }
    }
    return (best && bestDist <= 70) ? { id: best.id, name: best.name } : null;
  };

  function storageKey(sectionKey) { return `temirtau-map-overrides-${sectionKey}`; }
  function loadLocalOverrides(sectionKey) {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey(sectionKey)) || '{}');
      storedFeatureOverrides[sectionKey] = new Map(Object.entries(raw));
    } catch (err) {
      storedFeatureOverrides[sectionKey] = new Map();
    }
  }
  function saveLocalOverrides(sectionKey) {
    try { localStorage.setItem(storageKey(sectionKey), JSON.stringify(Object.fromEntries(storedFeatureOverrides[sectionKey]))); } catch (err) { }
  }

  function attachOverrides(sectionKey) {
    loadLocalOverrides(sectionKey);
    if (!FIRESTORE_AVAILABLE) {
      persistenceMode[sectionKey] = 'local';
      renderRegistryLayer(sectionKey);
      renderCatalog(sectionKey);
      return;
    }
    const section = sections[sectionKey];
    sectionUnsubscribers[sectionKey] = db.collection(section.collection).onSnapshot(snapshot => {
      const next = new Map();
      snapshot.forEach(doc => {
        const data = doc.data() || {};
        // geometry хранится в Firestore как JSON-строка (Firestore не
        // поддерживает вложенные массивы вроде [[{lat,lng},...]] для
        // полигонов) — распаковываем обратно в объект для рендера.
        if (typeof data.geometry === 'string') {
          try { data.geometry = JSON.parse(data.geometry); } catch (e) { /* оставляем как есть */ }
        }
        next.set(doc.id, data);
        // Если это новая точка добавленная через приложение — синхронизируем её
        // в локальный массив данных секции (у других клиентов её там нет)
        if (data.isNew && data.geometry && data.name) {
          const exists = section.data.some(f => f.id === doc.id);
          if (!exists) {
            section.data.push({
              id: doc.id,
              name: data.name,
              folder: data.folder || 'Без категории',
              description: data.description || '',
              geometry: data.geometry,
              style: data.style || {}
            });
          }
        }
      });
      storedFeatureOverrides[sectionKey] = next;
      persistenceMode[sectionKey] = 'firebase';
      if (activeSection === sectionKey) { renderRegistryLayer(); if (sectionKey === 'repair') refreshTaskFilterHighlight(); }
    }, error => {
      console.warn(`Не удалось подключить общие правки ${section.title}:`, error);
      persistenceMode[sectionKey] = 'local';
      if (activeSection === sectionKey) renderRegistryLayer();
    });
  }

  async function saveFeatureOverride(sectionKey, id, change) {
    const current = storedFeatureOverrides[sectionKey].get(id) || {};
    const combined = { ...current, ...change };
    storedFeatureOverrides[sectionKey].set(id, combined);
    saveLocalOverrides(sectionKey);
    if (FIRESTORE_AVAILABLE && persistenceMode[sectionKey] === 'firebase') {
      try {
        // Firestore не поддерживает вложенные массивы (полигоны хранят
        // coordinates как массив колец-массивов) — пакуем geometry в
        // JSON-строку перед записью, распаковываем обратно при чтении.
        const toSave = combined.geometry
          ? { ...combined, geometry: JSON.stringify(combined.geometry) }
          : combined;
        await db.collection(sections[sectionKey].collection).doc(id).set(toSave, { merge: true });
      } catch (error) {
        console.error(error);
        persistenceMode[sectionKey] = 'local';
        showToast('Общая база не приняла правку — она сохранена только на этом устройстве');
      }
    }
  }

  function initialise() {
    setupMapDependent();
    configureTopControls();
    document.querySelectorAll('.section-tab').forEach(tab => tab.addEventListener('click', () => switchSection(tab.dataset.section)));
    const filterBtn = document.getElementById('rvr-task-filter-btn');
    const filterMenu = document.getElementById('rvr-task-filter-menu');
    if (filterBtn && filterMenu) {
      filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        filterMenu.classList.toggle('hidden');
      });
      document.addEventListener('click', (e) => {
        if (!filterMenu.classList.contains('hidden') && !filterMenu.contains(e.target) && e.target !== filterBtn) {
          filterMenu.classList.add('hidden');
        }
      });
    }
    window.openTrashHistory = openHistoryPanel;
    attachOverrides('gis');
    attachOverrides('repair');
    showDataLoadWarning();
    let savedSection = localStorage.getItem('trash-map-section') || 'gis';
    if (savedSection === 'trash') savedSection = 'gis';
    switchSection(savedSection);
  }

  // index.html вешает свой DOMContentLoaded-обработчик (init -> initMap
  // -> bindUI) раньше, чем парсер доходит до этого скрипта, поэтому он
  // гарантированно отработает первым, и к моменту нашего запуска `map`
  // уже будет создана. Если DOM уже готов (скрипт почему-то подключили
  // асинхронно/в конце по-другому) — запускаемся сразу.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise);
  } else {
    initialise();
  }
})();