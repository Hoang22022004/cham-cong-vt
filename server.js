const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const COMPANY_IPS = ['118.69.234.214']; 

// --- Cấu hình Lark API ---
const APPS = {
    vt1: { 
        APP_ID: 'cli_aaad6f9e06a29ed2', APP_SECRET: '7r72kPZ7Dilw1aelU2lzBb1PxrwPTyoz',
        BASE_TOKEN: 'BubDbp3p7a5IwAsTURZlMsLGgTg', TABLE_ID: 'tblmYtoNX1lMQLZH'
    },
    vt2: { 
        APP_ID: 'cli_aa15c91481f8ded3', APP_SECRET: 'mMcAbt5qYRnFYTn7ikzqufxKjptAOQYk',
        BASE_TOKEN: 'EyXHbFsZwa51FssRSsclySoxgah', TABLE_ID: 'tblYZwCFUVDOBajD'
    }
};

// Hàm lấy Tenant Access Token
async function getTenantAccessToken(branch = 'vt1') {
    const config = APPS[branch] || APPS['vt1'];
    const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: config.APP_ID, app_secret: config.APP_SECRET })
    });
    const data = await res.json();
    return data.tenant_access_token;
}

// Hàm lấy App Access Token
async function getAppAccessToken(branch = 'vt1') {
    const config = APPS[branch] || APPS['vt1'];
    const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: config.APP_ID, app_secret: config.APP_SECRET })
    });
    const data = await res.json();
    return data.app_access_token;
}

// Kiểm tra xem timestamp có phải là ngày hôm nay ở VN không
function isTodayInVietnam(ts) {
    if (!ts) return false;
    const date = new Date(parseInt(ts));
    const today = new Date();
    const dateStr = date.toLocaleDateString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' });
    const todayStr = today.toLocaleDateString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' });
    return dateStr === todayStr;
}

// Lấy bản ghi chấm công của hôm nay từ Lark Base
async function getTodayRecord(userId, token, branch = 'vt1') {
    const config = APPS[branch] || APPS['vt1'];
    const searchRes = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${config.BASE_TOKEN}/tables/${config.TABLE_ID}/records/search?user_id_type=open_id`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            filter: {
                conjunction: 'and',
                conditions: [{ field_name: 'Nhân viên', operator: 'contains', value: [userId] }]
            },
            sort: [{ field_name: 'Ngày chấm công', desc: true }]
        })
    });
    const data = await searchRes.json();
    if (data.code === 0 && data.data && data.data.items && data.data.items.length > 0) {
        const latestRecord = data.data.items[0];
        if (isTodayInVietnam(latestRecord.fields['Ngày chấm công'])) {
            return latestRecord;
        }
    }
    return null;
}

// --- API: Lấy thông tin User và Trạng thái Chấm công ---
app.post('/api/login', async (req, res) => {
    try {
        const { code, branch } = req.body;
        if (!code) return res.status(400).json({ success: false, message: "Thiếu auth code" });

        const appAccessToken = await getAppAccessToken(branch);
        
        const userRes = await fetch('https://open.larksuite.com/open-apis/authen/v1/access_token', {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${appAccessToken}`,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ grant_type: 'authorization_code', code: code })
        });
        
        const userData = await userRes.json();
        
        if (userData.code !== 0) {
            return res.status(500).json({ success: false, message: "Lỗi danh tính" });
        }

        const userId = userData.data.open_id || userData.data.user_id;
        
        // Truy vấn Base để kiểm tra xem hôm nay người này đã chấm công những ô nào
        const tenantToken = await getTenantAccessToken(branch);
        const todayRecord = await getTodayRecord(userId, tenantToken, branch);
        
        let attendanceState = {};
        if (todayRecord) {
            const fields = todayRecord.fields;
            if (fields['Vào Sáng']) attendanceState.in_morning = new Date(fields['Vào Sáng']).toLocaleTimeString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit'});
            if (fields['Ra Sáng']) attendanceState.out_morning = new Date(fields['Ra Sáng']).toLocaleTimeString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit'});
            if (fields['Vào Chiều']) attendanceState.in_afternoon = new Date(fields['Vào Chiều']).toLocaleTimeString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit'});
            if (fields['Ra Chiều']) attendanceState.out_afternoon = new Date(fields['Ra Chiều']).toLocaleTimeString('vi-VN', {timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit'});
        }

        res.json({
            success: true,
            user: {
                name: userData.data.name,
                avatarUrl: userData.data.avatar_url,
                userId: userId
            },
            attendanceState: attendanceState // Trả trạng thái thực tế từ Base về Frontend
        });

    } catch (e) {
        console.error("Lỗi login:", e);
        res.status(500).json({ success: false, message: "Lỗi hệ thống khi đăng nhập" });
    }
});

// --- API: Xử lý Yêu cầu Chấm Công ---
app.post('/api/checkin', async (req, res) => {
    try {
        const { actionType, actionName, userId, userName, branch } = req.body;
        
        let userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (userIp && userIp.includes(',')) {
            userIp = userIp.split(',')[0].trim();
        }
        if (userIp.substr(0, 7) == "::ffff:") userIp = userIp.substr(7);

        // Kiểm tra IP
        if (COMPANY_IPS.length > 0 && !COMPANY_IPS.includes(userIp) && userIp !== '127.0.0.1' && userIp !== '::1') {
            return res.status(403).json({
                success: false,
                message: `Lỗi IP mạng công ty. (Của bạn: ${userIp})`
            });
        }

        if (!userId) return res.status(400).json({ success: false, message: "Chưa định danh nhân viên." });

        const token = await getTenantAccessToken(branch);
        const now = new Date().getTime(); 

        const fieldMap = {
            'in_morning': 'Vào Sáng',
            'out_morning': 'Ra Sáng',
            'in_afternoon': 'Vào Chiều',
            'out_afternoon': 'Ra Chiều'
        };
        const columnName = fieldMap[actionType];

        const config = APPS[branch] || APPS['vt1'];
        // Tìm xem hôm nay đã có dòng dữ liệu nào chưa
        const todayRecord = await getTodayRecord(userId, token, branch);

        let larkRes, larkData;
        let cName = (branch === 'vt2') ? 'VT2' : 'VT1';

        if (todayRecord) {
            // ĐÃ CÓ DỮ LIỆU HÔM NAY -> CHỈ CẦN UPDATE (CẬP NHẬT) CỘT TƯƠNG ỨNG
            const updateData = {
                fields: {
                    [columnName]: now,
                    "Ghi chú": todayRecord.fields['Ghi chú'] ? todayRecord.fields['Ghi chú'] + `\nĐã gửi ${actionName} (${cName})` : `Đã gửi ${actionName} (${cName})`
                }
            };

            larkRes = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${config.BASE_TOKEN}/tables/${config.TABLE_ID}/records/${todayRecord.record_id}?user_id_type=open_id`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
            });
        } else {
            // CHƯA CÓ DỮ LIỆU -> TẠO DÒNG MỚI (CREATE)
            const recordData = {
                fields: {
                    "Nhân viên": [{ "id": userId }],
                    "Ngày chấm công": now,
                    [columnName]: now,
                    "IP Mạng": userIp,
                    "Ghi chú": `Đã gửi ${actionName} qua Web App (${cName})`
                }
            };

            larkRes = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${config.BASE_TOKEN}/tables/${config.TABLE_ID}/records?user_id_type=open_id`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(recordData)
            });
        }
        
        larkData = await larkRes.json();
        
        if (larkData.code !== 0) {
            console.error("Lỗi Lark Base:", larkData);
            return res.status(500).json({ success: false, message: `Lỗi lưu Base: ${larkData.msg}` });
        }
        
        res.json({ success: true, message: `Ghi nhận thành công!` });

    } catch (error) {
        console.error("Lỗi chấm công:", error);
        res.status(500).json({ success: false, message: "Lỗi máy chủ nội bộ" });
    }
});

app.listen(port, () => {
    console.log(`🚀 Server chấm công đang chạy tại: http://localhost:${port}`);
});
