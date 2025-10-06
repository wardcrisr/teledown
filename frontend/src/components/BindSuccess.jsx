import React from 'react';

function BindSuccess({ chatId }) {
  return (
    <div className="bind-success" style={{ maxWidth: 640, margin: '40px auto', textAlign: 'center' }}>
      <h2>绑定成功 ✅</h2>
      <p style={{ marginTop: 12 }}>已将本网页登录会话绑定到你的机器人聊天。</p>
      <p style={{ color: '#666' }}>Chat ID: <code>{chatId}</code></p>
      <div style={{ marginTop: 24 }}>
        <p>你现在可以返回 Telegram，在机器人里发送链接进行下载。</p>
      </div>
    </div>
  );
}

export default BindSuccess;
