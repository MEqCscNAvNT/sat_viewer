document.addEventListener('DOMContentLoaded', () => {
    let obsLoc = { lat: 35.4667, lng: 136.6167, height: 0.05 }; 
    let obsName = "岐阜県大野町"; // GPSがオフの時のデフォルト

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            obsLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, height: (pos.coords.altitude || 50) / 1000 };
            obsName = "GPS現在地";
            document.getElementById('observerStatus').textContent = `観測地: ${obsName}`;
            trackedSats.forEach(sat => updateAosLos(sat));
        }, () => {
            document.getElementById('observerStatus').textContent = `観測地: ${obsName} (GPS未許可)`;
        });
    }

    // ★ 地図のズームアウト制限を緩和 (3 -> 1)
    const map = L.map('map', {
        center: [36.2048, 138.2529], 
        zoom: 2,    // 初期ズームを少し引いた状態に
        minZoom: 1  // 北極から南極まで表示可能に
    });
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        noWrap: false
    }).addTo(map);

    let updateIntervalId = null;
    let allSatData = {}; 
    const EARTH_RADIUS_KM = 6371;
    let trackedSats = [];
    const PALETTE = ['#ff3333', '#33ff33', '#33ccff']; 

    const satIcon = L.icon({
        iconUrl: 'https://upload.wikimedia.org/wikipedia/commons/d/d0/International_Space_Station.svg',
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });

    function ommToTle(omm) {
        const pad = (str, len, char = ' ', right = false) => {
            str = String(str);
            while (str.length < len) str = right ? str + char : char + str;
            return str.substring(0, len);
        };
        let id = omm.NORAD_CAT_ID;
        let idStr = id > 99999 ? String.fromCharCode(55 + Math.floor(id/10000)) + pad(id%10000, 4, '0') : pad(id, 5, '0');
        let intDesigStr = "        ";
        if (omm.OBJECT_ID) {
            let parts = omm.OBJECT_ID.split('-');
            if (parts.length === 2) intDesigStr = pad(parts[0].substring(2) + parts[1], 8, ' ', true);
        }
        let epoch = new Date(omm.EPOCH + "Z");
        let year = epoch.getUTCFullYear();
        let epochYear = pad(year % 100, 2, '0');
        let startOfYear = new Date(Date.UTC(year, 0, 0));
        let epochDay = (epoch - startOfYear) / 86400000;
        let epochDayStr = pad(epochDay.toFixed(8), 12, '0');
        let ndot = omm.MEAN_MOTION_DOT || 0;
        let ndotStr = ndot.toFixed(8).replace(/^0\./, '.').replace(/^-0\./, '-.');
        if (ndotStr[0] !== '-') ndotStr = ' ' + ndotStr;
        ndotStr = pad(ndotStr.substring(0, 10), 10, ' ', true);
        let bstar = omm.BSTAR || 0;
        let bstarStr = " 00000-0";
        if (bstar !== 0) {
            let exp = Math.floor(Math.log10(Math.abs(bstar)));
            let mantissa = Math.round((Math.abs(bstar) / Math.pow(10, exp)) * 10000);
            let sign = bstar < 0 ? "-" : " ";
            let expSign = (exp+1) < 0 ? "-" : "+";
            bstarStr = sign + pad(mantissa, 5, '0') + expSign + Math.abs(exp+1);
        }
        let line1 = `1 ${idStr}${omm.CLASSIFICATION_TYPE || 'U'} ${intDesigStr} ${epochYear}${epochDayStr} ${ndotStr}  00000-0 ${bstarStr} 0  999`;
        let inc = pad((omm.INCLINATION||0).toFixed(4), 8, ' ');
        let raan = pad((omm.RA_OF_ASC_NODE||0).toFixed(4), 8, ' ');
        let ecc = pad((omm.ECCENTRICITY||0).toFixed(7).substring(2), 7, '0');
        let argp = pad((omm.ARG_OF_PERICENTER||0).toFixed(4), 8, ' ');
        let ma = pad((omm.MEAN_ANOMALY||0).toFixed(4), 8, ' ');
        let mm = pad((omm.MEAN_MOTION||0).toFixed(8), 11, ' ');
        let rev = pad(omm.REV_AT_EPOCH||0, 5, ' ');
        let line2 = `2 ${idStr} ${inc} ${raan} ${ecc} ${argp} ${ma} ${mm}${rev}`;
        const calcChecksum = (line) => {
            let sum = 0;
            for (let i = 0; i < 68; i++) {
                let c = line[i];
                if (c >= '0' && c <= '9') sum += parseInt(c);
                else if (c === '-') sum += 1;
            }
            return sum % 10;
        };
        return { tle1: line1 + calcChecksum(line1), tle2: line2 + calcChecksum(line2) };
    }

    function updateAosLos(sat) {
        const obsGd = {
            longitude: satellite.degreesToRadians(obsLoc.lng),
            latitude: satellite.degreesToRadians(obsLoc.lat),
            height: obsLoc.height
        };
        let now = new Date();
        sat.aos = null;
        sat.los = null;
        let isUp = false;

        for (let i = 0; i < 4320; i++) {
            let time = new Date(now.getTime() + i * 60000);
            let pAndV = satellite.propagate(sat.satrec, time);
            if (!pAndV.position) continue;

            let gmst = satellite.gstime(time);
            let posEcf = satellite.eciToEcf(pAndV.position, gmst);
            let look = satellite.ecfToLookAngles(obsGd, posEcf);
            
            if (look.elevation > 0) {
                if (i === 0) isUp = true;
                if (!isUp && !sat.aos) {
                    sat.aos = time;
                    isUp = true;
                }
            } else {
                if (isUp) {
                    sat.los = time;
                    break;
                }
            }
        }
        sat.isUpNow = (sat.aos === null && sat.los !== null);
    }

    function formatTime(date) {
        if (!date) return "---";
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(date.getMonth()+1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // ★ データ取得の堅牢化 (エラーで片方が止まってもOKにする)
    async function loadTargetSats() {
        const inputEl = document.getElementById('satInput');
        const datalistEl = document.getElementById('satList');
        const addBtn = document.getElementById('addBtn');
        const loadingText = document.getElementById('loadingText');
        
        try {
            loadingText.textContent = "データをダウンロード中...";
            let combinedData = [];

            // ステーションの取得
            try {
                const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json');
                if(res.ok) combinedData.push(...(await res.json()));
            } catch(e) { console.error("Stations fetch failed"); }

            // キューブサットの取得
            try {
                const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=cubesat&FORMAT=json');
                if(res.ok) combinedData.push(...(await res.json()));
            } catch(e) { console.error("CubeSats fetch failed"); }

            if (combinedData.length === 0) throw new Error("データの取得に失敗しました。");

            datalistEl.innerHTML = ''; 
            const fragment = document.createDocumentFragment();

            combinedData.forEach(sat => {
                const name = sat.OBJECT_NAME;
                if (!allSatData[name]) {
                    allSatData[name] = sat; 
                    const option = document.createElement('option');
                    option.value = name;
                    fragment.appendChild(option);
                }
            });
            datalistEl.appendChild(fragment);

            loadingText.textContent = ""; // 成功時は文字を消してスッキリさせる
            inputEl.disabled = false; 
            addBtn.disabled = false;

            updateIntervalId = setInterval(updatePositions, 1000);

        } catch (error) {
            loadingText.textContent = "ダウンロードに失敗しました。";
            loadingText.style.color = "red";
        }
    }

    function getAvailableColor() {
        const usedColors = trackedSats.map(s => s.color);
        return PALETTE.find(c => !usedColors.includes(c));
    }

    async function addSatellite(satInputVal) {
        if (!satInputVal) return;
        if (trackedSats.length >= 3) { alert("同時にトラッキングできるのは最大3機までです。"); return; }
        if (trackedSats.find(s => s.originalInput === satInputVal || s.name === satInputVal)) { alert("その衛星はすでにトラッキング中です。"); return; }

        let satData, satName;
        const addBtn = document.getElementById('addBtn');
        addBtn.disabled = true;

        if (/^\d{5,6}$/.test(satInputVal)) {
            try {
                const response = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${satInputVal}&FORMAT=json`);
                if (!response.ok) throw new Error("HTTP Error");
                const data = await response.json();
                if (!data || data.length === 0 || data === "No GP data found") {
                    alert(`NORAD ID: ${satInputVal} のデータは見つかりませんでした。`);
                    addBtn.disabled = false; return;
                }
                satData = data[0]; 
                const officialName = satData.OBJECT_NAME;
                const customName = prompt(`NORAD ID: ${satInputVal} の公式登録名は「${officialName}」です。\n表示名を変更する場合は入力してください。`, officialName);
                if (customName === null) {
                    addBtn.disabled = false;
                    document.getElementById('satInput').value = '';
                    return;
                }
                satName = customName.trim() || officialName;
            } catch (error) {
                alert("APIからの直接取得に失敗しました。");
                addBtn.disabled = false; return;
            }
        } else {
            if (!allSatData[satInputVal]) {
                alert("無効な入力です。リストから選ぶか、NORAD IDを入力してください。");
                addBtn.disabled = false; return;
            }
            satName = satInputVal; 
            satData = allSatData[satInputVal]; 
        }

        let satrec;
        try {
            const generatedTle = ommToTle(satData);
            satrec = satellite.twoline2satrec(generatedTle.tle1, generatedTle.tle2);
        } catch (e) {
            alert("軌道データのパースに失敗しました。");
            addBtn.disabled = false; return;
        }
        
        const color = getAvailableColor();
        const periodMin = (2 * Math.PI) / satrec.no;
        const orbitLayer = L.layerGroup().addTo(map);

        const newSat = { 
            originalInput: satInputVal, 
            name: satName, 
            satrec: satrec, 
            color: color, 
            period: periodMin, 
            orbitLayer: orbitLayer 
        };

        updateAosLos(newSat);
        trackedSats.push(newSat);

        renderInfoPanels();
        updatePositions();
        document.getElementById('satInput').value = ''; 
        addBtn.disabled = false;
    }

    window.removeSatellite = function(satName) {
        const index = trackedSats.findIndex(s => s.name === satName);
        if (index > -1) {
            const sat = trackedSats[index];
            map.removeLayer(sat.orbitLayer);
            trackedSats.splice(index, 1);
            renderInfoPanels();
        }
    }

    function renderInfoPanels() {
        const container = document.getElementById('infoContainer');
        container.innerHTML = '';
        trackedSats.forEach((sat, index) => {
            const safeId = "sat_" + index;
            sat.htmlId = safeId;
            const card = document.createElement('div');
            card.className = 'info-card';
            card.style.borderTop = `5px solid ${sat.color}`;
            
            card.innerHTML = `
                <h4>${sat.name} <button class="del-btn" onclick="removeSatellite('${sat.name}')">✖</button></h4>
                <div>Lat: <span class="info-value" id="lat-${safeId}">---</span>&deg;</div>
                <div>Lng: <span class="info-value" id="lng-${safeId}">---</span>&deg;</div>
                <div>Height: <span class="info-value" id="alt-${safeId}">---</span> km</div>
                <div>Velocity: <span class="info-value" id="vel-${safeId}">---</span> km/s</div>
                <div class="aos-los">
                    <strong>AOS (出現):</strong> ${sat.isUpNow ? '<span style="color:red; font-weight:bold;">現在上空を通過中！</span>' : formatTime(sat.aos)}<br>
                    <strong>LOS (沈む):</strong> ${formatTime(sat.los)}
                </div>
            `;
            container.appendChild(card);
        });
    }

    function updatePositions() {
        const now = new Date();
        const gmst = satellite.gstime(now);

        const currentCenterLng = map.getCenter().lng;
        const baseOffset = Math.round(currentCenterLng / 360) * 360;
        const mapOffsets = [baseOffset - 360, baseOffset, baseOffset + 360];

        trackedSats.forEach(sat => {
            const positionAndVelocity = satellite.propagate(sat.satrec, now);
            if (!positionAndVelocity.position || !positionAndVelocity.velocity) return;

            if (sat.los && now > sat.los) {
                updateAosLos(sat);
                renderInfoPanels();
            }

            const posEci = positionAndVelocity.position;
            const velEci = positionAndVelocity.velocity;
            
            const posGd = satellite.eciToGeodetic(posEci, gmst);
            const latitude = satellite.degreesLat(posGd.latitude);
            const longitude = satellite.degreesLong(posGd.longitude);
            const heightKm = posGd.height;
            const velocityKmS = Math.sqrt(velEci.x * velEci.x + velEci.y * velEci.y + velEci.z * velEci.z);

            document.getElementById(`lat-${sat.htmlId}`).textContent = latitude.toFixed(4);
            document.getElementById(`lng-${sat.htmlId}`).textContent = longitude.toFixed(4);
            document.getElementById(`alt-${sat.htmlId}`).textContent = heightKm.toFixed(2);
            document.getElementById(`vel-${sat.htmlId}`).textContent = velocityKmS.toFixed(2);

            const centralAngleRad = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + heightKm));
            const outerRadiusMeters = EARTH_RADIUS_KM * centralAngleRad * 1000;
            const innerRadiusMeters = outerRadiusMeters * 0.5;

            const pastSegments = [];
            const futureSegments = [];
            let currentPastSegment = [];
            let currentFutureSegment = [];
            let prevLngPast = null;
            let prevLngFuture = null;
            
            const steps = Math.ceil(sat.period * 2); 

            for (let i = -steps; i <= 0; i++) {
                const time = new Date(now.getTime() + i * 30000); 
                const pAndV = satellite.propagate(sat.satrec, time);
                if (pAndV.position) {
                    const tGmst = satellite.gstime(time);
                    const tPosGd = satellite.eciToGeodetic(pAndV.position, tGmst);
                    const lng = satellite.degreesLong(tPosGd.longitude);
                    const lat = satellite.degreesLat(tPosGd.latitude);
                    if (prevLngPast !== null && Math.abs(lng - prevLngPast) > 180) {
                        pastSegments.push(currentPastSegment);
                        currentPastSegment = [];
                    }
                    currentPastSegment.push([lat, lng]);
                    prevLngPast = lng;
                }
            }
            if (currentPastSegment.length > 0) pastSegments.push(currentPastSegment);

            for (let i = 0; i <= steps; i++) {
                const time = new Date(now.getTime() + i * 30000); 
                const pAndV = satellite.propagate(sat.satrec, time);
                if (pAndV.position) {
                    const tGmst = satellite.gstime(time);
                    const tPosGd = satellite.eciToGeodetic(pAndV.position, tGmst);
                    const lng = satellite.degreesLong(tPosGd.longitude);
                    const lat = satellite.degreesLat(tPosGd.latitude);
                    if (prevLngFuture !== null && Math.abs(lng - prevLngFuture) > 180) {
                        futureSegments.push(currentFutureSegment);
                        currentFutureSegment = [];
                    }
                    currentFutureSegment.push([lat, lng]);
                    prevLngFuture = lng;
                }
            }
            if (currentFutureSegment.length > 0) futureSegments.push(currentFutureSegment);

            sat.orbitLayer.clearLayers();

            mapOffsets.forEach(offset => {
                L.marker([latitude, longitude + offset], {icon: satIcon}).addTo(sat.orbitLayer);
                L.circle([latitude, longitude + offset], { radius: outerRadiusMeters, color: sat.color, fill: false, weight: 2, opacity: 0.7 }).addTo(sat.orbitLayer);
                L.circle([latitude, longitude + offset], { radius: innerRadiusMeters, color: sat.color, fill: false, weight: 1, opacity: 0.4, dashArray: '5,5' }).addTo(sat.orbitLayer);

                pastSegments.forEach(segment => {
                    const offsetSegment = segment.map(coord => [coord[0], coord[1] + offset]);
                    L.polyline(offsetSegment, {
                        color: sat.color, weight: 2, opacity: 0.5, dashArray: '5, 8'
                    }).addTo(sat.orbitLayer);
                });

                futureSegments.forEach(segment => {
                    if (segment.length < 2) return; 
                    const offsetSegment = segment.map(coord => [coord[0], coord[1] + offset]);
                    const futureLine = L.polyline(offsetSegment, {
                        color: sat.color, weight: 2, opacity: 0.9
                    }).addTo(sat.orbitLayer);
                    
                    if (L.Symbol && L.Symbol.arrowHead) {
                        L.polylineDecorator(futureLine, {
                            patterns: [
                                { offset: 50, repeat: 150, symbol: L.Symbol.arrowHead({pixelSize: 12, polygon: true, pathOptions: {color: sat.color, fillOpacity: 0.9, weight: 0}}) }
                            ]
                        }).addTo(sat.orbitLayer);
                    }
                });
            });
        });
    }

    document.getElementById('addBtn').addEventListener('click', () => {
        addSatellite(document.getElementById('satInput').value.trim());
    });
    document.getElementById('satInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') addSatellite(e.target.value.trim());
    });

    loadTargetSats();
});