document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('theme-osm');

    let obsLoc = { lat: 35.4667, lng: 136.6167, height: 0.05 }; 
    let obsName = "岐阜県大野町"; 

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            obsLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, height: (pos.coords.altitude || 50) / 1000 };
            obsName = "GPS現在地";
            document.getElementById('observerStatus').textContent = `観測地: ${obsName}`;
            trackedSats.forEach(sat => findNextPass(sat));
            renderInfoPanels();
        }, () => {
            document.getElementById('observerStatus').textContent = `観測地: ${obsName} (GPS未許可)`;
        });
    }

    const map = L.map('map', { center: [36.2048, 138.2529], zoom: 2, minZoom: 1 });
    
    const mapStyles = {
        osm: {
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { attribution: '© OpenStreetMap', noWrap: false }
        },
        satellite: {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            options: { attribution: '© Esri', noWrap: false }
        },
        light: {
            url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
            options: { attribution: '© CartoDB', noWrap: false }
        }
    };

    let currentTileLayer = L.tileLayer(mapStyles.osm.url, mapStyles.osm.options).addTo(map);

    document.getElementById('mapStyle').addEventListener('change', function(e) {
        const selectedStyle = e.target.value;
        map.removeLayer(currentTileLayer);
        currentTileLayer = L.tileLayer(mapStyles[selectedStyle].url, mapStyles[selectedStyle].options);
        
        if (!document.body.classList.contains('x-m')) {
            currentTileLayer.addTo(map);
        }
        
        document.body.className = document.body.className.replace(/theme-\w+/g, '');
        document.body.classList.add('theme-' + selectedStyle);
    });

    let updateIntervalId = null;
    let allSatData = {}; 
    const EARTH_RADIUS_KM = 6371;
    let trackedSats = [];
    const PALETTE = ['#ff3333', '#33ff33', '#33ccff']; 

    const satIcon = L.icon({
        iconUrl: 'https://upload.wikimedia.org/wikipedia/commons/d/d0/International_Space_Station.svg',
        iconSize: [40, 40], iconAnchor: [20, 20]
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

    function findNextPass(sat) {
        const obsGd = {
            longitude: satellite.degreesToRadians(obsLoc.lng),
            latitude: satellite.degreesToRadians(obsLoc.lat),
            height: obsLoc.height
        };
        let time = new Date();
        
        let pAndV = satellite.propagate(sat.satrec, time);
        let look = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(pAndV.position, satellite.gstime(time)));
        let currentEl = satellite.radiansToDegrees(look.elevation);

        let aosTime = null;
        let losTime = null;

        if (currentEl > 0) {
            let tempTime = new Date(time.getTime());
            while (true) {
                tempTime = new Date(tempTime.getTime() - 60000);
                let p = satellite.propagate(sat.satrec, tempTime);
                let l = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(p.position, satellite.gstime(tempTime)));
                if (satellite.radiansToDegrees(l.elevation) <= 0) {
                    aosTime = new Date(tempTime.getTime() + 60000);
                    break;
                }
            }
            tempTime = new Date(time.getTime());
            while (true) {
                tempTime = new Date(tempTime.getTime() + 60000);
                let p = satellite.propagate(sat.satrec, tempTime);
                let l = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(p.position, satellite.gstime(tempTime)));
                if (satellite.radiansToDegrees(l.elevation) <= 0) {
                    losTime = tempTime;
                    break;
                }
            }
        } else {
            let tempTime = new Date(time.getTime());
            for (let i = 0; i < 4320; i++) { 
                tempTime = new Date(time.getTime() + i * 60000);
                let p = satellite.propagate(sat.satrec, tempTime);
                let l = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(p.position, satellite.gstime(tempTime)));
                if (satellite.radiansToDegrees(l.elevation) > 0) {
                    aosTime = tempTime;
                    break;
                }
            }
            if (aosTime) {
                tempTime = new Date(aosTime.getTime());
                while (true) {
                    tempTime = new Date(tempTime.getTime() + 60000);
                    let p = satellite.propagate(sat.satrec, tempTime);
                    let l = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(p.position, satellite.gstime(tempTime)));
                    if (satellite.radiansToDegrees(l.elevation) <= 0) {
                        losTime = tempTime;
                        break;
                    }
                }
            }
        }

        sat.aos = aosTime;
        sat.los = losTime;
        sat.isUpNow = (currentEl > 0);
        sat.passData = [];
        sat.maxEl = 0;
        sat.riseAz = null;
        sat.setAz = null;

        if (aosTime && losTime) {
            let stepMs = (losTime - aosTime) / 30; 
            for (let t = aosTime.getTime(); t <= losTime.getTime(); t += stepMs) {
                let p = satellite.propagate(sat.satrec, new Date(t));
                let l = satellite.ecfToLookAngles(obsGd, satellite.eciToEcf(p.position, satellite.gstime(new Date(t))));
                let el = satellite.radiansToDegrees(l.elevation);
                let az = satellite.radiansToDegrees(l.azimuth);

                if (el < 0) el = 0; 
                sat.passData.push({az: az, el: el});
                
                if (el > sat.maxEl) sat.maxEl = el;
                if (sat.riseAz === null) sat.riseAz = az;
                sat.setAz = az; 
            }
        }
    }

    function drawPolarPlot(canvasId, passData, color) {
        const canvas = document.getElementById(canvasId);
        if(!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const cx = width / 2;
        const cy = height / 2;
        const rMax = Math.min(cx, cy) - 15; 
        
        const isXM = document.body.classList.contains('x-m');

        ctx.clearRect(0,0,width,height);

        ctx.strokeStyle = isXM ? 'rgba(255, 255, 255, 0.3)' : '#ddd';
        ctx.fillStyle = isXM ? '#88ddff' : '#666';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '10px sans-serif';

        [0, 30, 60].forEach(el => {
            const r = rMax * (1 - el/90);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2*Math.PI);
            ctx.stroke();
        });

        ctx.beginPath();
        ctx.moveTo(cx, cy - rMax); ctx.lineTo(cx, cy + rMax);
        ctx.moveTo(cx - rMax, cy); ctx.lineTo(cx + rMax, cy);
        ctx.stroke();

        ctx.fillText('N', cx, cy - rMax - 8);
        ctx.fillText('S', cx, cy + rMax + 8);
        ctx.fillText('E', cx + rMax + 8, cy);
        ctx.fillText('W', cx - rMax - 8, cy);

        if(!passData || passData.length === 0) return;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        passData.forEach((pt, idx) => {
            const angleRad = (pt.az - 90) * Math.PI / 180; 
            const r = rMax * (1 - pt.el / 90);
            const x = cx + r * Math.cos(angleRad);
            const y = cy + r * Math.sin(angleRad);
            if(idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        const drawPoint = (pt, ptColor) => {
            const angleRad = (pt.az - 90) * Math.PI / 180;
            const r = rMax * (1 - pt.el / 90);
            const x = cx + r * Math.cos(angleRad);
            const y = cy + r * Math.sin(angleRad);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, 2*Math.PI);
            ctx.fillStyle = ptColor;
            ctx.fill();
            if(!isXM) ctx.stroke();
        };

        drawPoint(passData[0], isXM ? '#ffffff' : '#28a745'); 
        drawPoint(passData[passData.length-1], isXM ? '#ff66aa' : '#dc3545'); 
    }

    function formatTime(date) {
        if (!date) return "---";
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(date.getMonth()+1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    async function loadTargetSats() {
        const inputEl = document.getElementById('satInput');
        const datalistEl = document.getElementById('satList');
        const addBtn = document.getElementById('addBtn');
        const loadingText = document.getElementById('loadingText');
        
        try {
            loadingText.textContent = "データをダウンロード中...";
            let combinedData = [];

            try {
                const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json');
                if(res.ok) combinedData.push(...(await res.json()));
            } catch(e) {}

            try {
                const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=cubesat&FORMAT=json');
                if(res.ok) combinedData.push(...(await res.json()));
            } catch(e) {}

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

            loadingText.textContent = ""; 
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
            orbitLayer: orbitLayer,
            showPlot: false 
        };

        findNextPass(newSat);
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
            
            let plotHtml = '';
            if (sat.showPlot) {
                plotHtml = `
                    <div class="polar-plot-container">
                        <div class="pass-details">
                            <div><strong>Rise:</strong> ${sat.riseAz ? sat.riseAz.toFixed(1) : '---'}&deg;</div>
                            <div><strong>Max:</strong> ${sat.maxEl ? sat.maxEl.toFixed(1) : '---'}&deg;</div>
                            <div><strong>Set:</strong> ${sat.setAz ? sat.setAz.toFixed(1) : '---'}&deg;</div>
                        </div>
                        <canvas id="polar-${safeId}" width="180" height="180" class="polar-canvas"></canvas>
                    </div>
                `;
            }

            const latStr = sat.currentLat !== undefined ? sat.currentLat.toFixed(4) : '---';
            const lngStr = sat.currentLng !== undefined ? sat.currentLng.toFixed(4) : '---';
            const altStr = sat.currentHeight !== undefined ? sat.currentHeight.toFixed(2) : '---';
            const velStr = sat.currentVelocity !== undefined ? sat.currentVelocity.toFixed(2) : '---';

            card.innerHTML = `
                <h4>${sat.name} <button class="del-btn" onclick="removeSatellite('${sat.name}')">✖</button></h4>
                <div>Lat: <span class="info-value" id="lat-${safeId}">${latStr}</span>&deg;</div>
                <div>Lng: <span class="info-value" id="lng-${safeId}">${lngStr}</span>&deg;</div>
                <div>Height: <span class="info-value" id="alt-${safeId}">${altStr}</span> km</div>
                <div>Velocity: <span class="info-value" id="vel-${safeId}">${velStr}</span> km/s</div>
                <div>Period: <span class="info-value">${sat.period.toFixed(2)}</span> min</div>
                <div class="aos-los">
                    <strong>AOS (出現):</strong> ${sat.isUpNow ? '<span style="color:red; font-weight:bold;">現在上空を通過中！</span>' : formatTime(sat.aos)}<br>
                    <strong>LOS (沈む):</strong> ${formatTime(sat.los)}
                </div>
                <button class="toggle-plot-btn" data-name="${sat.name}">
                    ${sat.showPlot ? '▲ パス詳細を隠す' : '▼ パス詳細 (Polar Plot) を表示'}
                </button>
                ${plotHtml}
            `;
            container.appendChild(card);
        });

        document.querySelectorAll('.toggle-plot-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const satName = e.target.getAttribute('data-name');
                const sat = trackedSats.find(s => s.name === satName);
                if (sat) {
                    sat.showPlot = !sat.showPlot;
                    renderInfoPanels(); 
                }
            });
        });

        trackedSats.forEach(sat => {
            if (sat.showPlot && sat.passData) {
                drawPolarPlot(`polar-${sat.htmlId}`, sat.passData, sat.color);
            }
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
                findNextPass(sat);
                renderInfoPanels();
            }

            const posEci = positionAndVelocity.position;
            const velEci = positionAndVelocity.velocity;
            
            const posGd = satellite.eciToGeodetic(posEci, gmst);
            const latitude = satellite.degreesLat(posGd.latitude);
            const longitude = satellite.degreesLong(posGd.longitude);
            const heightKm = posGd.height;
            const velocityKmS = Math.sqrt(velEci.x * velEci.x + velEci.y * velEci.y + velEci.z * velEci.z);

            sat.currentLat = latitude;
            sat.currentLng = longitude;
            sat.currentHeight = heightKm;
            sat.currentVelocity = velocityKmS;

            const latEl = document.getElementById(`lat-${sat.htmlId}`);
            if(latEl) latEl.textContent = latitude.toFixed(4);
            const lngEl = document.getElementById(`lng-${sat.htmlId}`);
            if(lngEl) lngEl.textContent = longitude.toFixed(4);
            const altEl = document.getElementById(`alt-${sat.htmlId}`);
            if(altEl) altEl.textContent = heightKm.toFixed(2);
            const velEl = document.getElementById(`vel-${sat.htmlId}`);
            if(velEl) velEl.textContent = velocityKmS.toFixed(2);

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

    document.addEventListener('keydown', e => {
        if (e.key === 'd' && e.target.tagName !== 'INPUT') {
            document.body.classList.toggle('x-m');
            const isXM = document.body.classList.contains('x-m');
            
            if (isXM) {
                map.removeLayer(currentTileLayer);
                
                if (!window.xLayer) {
                    window.xLayer = L.layerGroup();
                    
                    // ★ 修正1: 緯度経度グリッド線 (30度刻みの薄緑色の点線) ★
                    //interactive: falseでクリックを透過させ、 weight: 1, opacity: 0.2で薄くする
                    for (let lat = -90; lat <= 90; lat += 30) {
                        L.polyline([[lat, -1080], [lat, 1080]], { color: '#00ff00', weight: 1, opacity: 0.2, className: 'x-grid', interactive: false }).addTo(window.xLayer);
                    }
                    for (let lng = -1080; lng <= 1080; lng += 30) {
                        L.polyline([[90, lng], [-90, lng]], { color: '#00ff00', weight: 1, opacity: 0.2, className: 'x-grid', interactive: false }).addTo(window.xLayer);
                    }

                    // ★ 修正2: 海岸線と国境線を含んだ、より精細なデータを使用 ★
                    //Natural Earthの1:110mスケールデータ。海岸線、国境、主要な島を含む。
                    Promise.all([
                        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson').then(r => r.json()),
                        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_boundary_lines_land.geojson').then(r => r.json())
                    ]).then(([coastData, borderData]) => {
                        [-720, -360, 0, 360, 720].forEach(offset => {
                            // 海岸線 (太め、ネオンシアン)
                            L.geoJSON(coastData, {
                                style: { color: '#44aaff', weight: 1.5, opacity: 0.9, className: 'x-coast' },
                                coordsToLatLng: function (coords) {
                                    return new L.LatLng(coords[1], coords[0] + offset);
                                }
                            }).addTo(window.xLayer);
                            
                            // 国境線 (細め、ネオンシアン)
                            L.geoJSON(borderData, {
                                style: { color: '#44aaff', weight: 0.5, opacity: 0.4, className: 'x-border' },
                                coordsToLatLng: function (coords) {
                                    return new L.LatLng(coords[1], coords[0] + offset);
                                }
                            }).addTo(window.xLayer);
                        });

                        // 読み込みが完了した時点で秘匿モードなら表示
                        if (document.body.classList.contains('x-m')) {
                            window.xLayer.addTo(map);
                        }
                    });
                } else {
                    window.xLayer.addTo(map);
                }
            } else {
                if (window.xLayer) map.removeLayer(window.xLayer);
                currentTileLayer.addTo(map);
            }
            
            renderInfoPanels();
        }
    });
});
