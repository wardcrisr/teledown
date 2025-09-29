import React, { useState } from 'react';
import './LoginForm.css';

function LoginForm({ onLogin }) {
  const [loginMethod, setLoginMethod] = useState('qr'); // Default to QR code
  const [step, setStep] = useState('choice');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [qrExpires, setQrExpires] = useState(null);
  const [checkingQR, setCheckingQR] = useState(false);

  const handleQRLogin = async () => {
    setLoading(true);
    setError('');
    setStep('qr');

    try {
      const response = await fetch('/api/auth/qr/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();
      
      if (response.ok) {
        if (data.authenticated) {
          // Already authenticated
          setSessionId(data.sessionId);
          onLogin(data.sessionId);
        } else {
          setSessionId(data.sessionId);
          setQrCode(data.qrCode);
          setQrExpires(data.expires);
          setCheckingQR(true);
          // Start polling for QR code status
          pollQRStatus(data.sessionId);
        }
      } else {
        setError(data.error || 'Failed to generate QR code');
        setStep('choice');
      }
    } catch (err) {
      setError('Network error. Please try again.');
      setStep('choice');
    } finally {
      setLoading(false);
    }
  };

  const pollQRStatus = async (sid) => {
    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/auth/qr/status/${sid}`);
        const data = await response.json();
        
        if (data.authenticated) {
          setCheckingQR(false);
          onLogin(sid);
          return true;
        } else if (data.status === 'expired' || data.needsRefresh) {
          setCheckingQR(false);
          setError('QR code expired. Please generate a new one.');
          setStep('choice');
          return true;
        }
        return false;
      } catch (err) {
        console.error('Error checking QR status:', err);
        return false;
      }
    };

    // Poll every 2 seconds
    const intervalId = setInterval(async () => {
      if (await checkStatus()) {
        clearInterval(intervalId);
      }
    }, 2000);

    // Stop polling after 5 minutes
    setTimeout(() => {
      clearInterval(intervalId);
      setCheckingQR(false);
      setError('QR code expired. Please try again.');
      setStep('choice');
    }, 300000);
  };

  const handlePhoneLogin = () => {
    setLoginMethod('phone');
    setStep('phone');
    setError('');
  };

  const handlePhoneSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });

      const data = await response.json();
      
      if (response.ok) {
        setSessionId(data.sessionId);
        setStep('code');
      } else {
        setError(data.error || 'Failed to send code');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, code, password })
      });

      const data = await response.json();
      
      if (response.ok) {
        onLogin(sessionId);
      } else if (
        data.step === 'password_required' ||
        data.code === 'SESSION_PASSWORD_NEEDED' ||
        /password/i.test(data.error || '')
      ) {
        setStep('password');
        setError('Two-factor authentication is enabled. Please enter your password.');
      } else if (data.code === 'PHONE_CODE_EXPIRED') {
        setError('Verification code expired. Please request a new one.');
      } else if (data.code === 'PHONE_CODE_INVALID') {
        setError('Invalid verification code. Use the newest code and try again.');
      } else if (data.code === 'PHONE_NUMBER_UNOCCUPIED') {
        setError('This phone number is not registered on Telegram.');
      } else if (data.code === 'FLOOD_WAIT') {
        setError(`Too many attempts. Please wait ${data.retryAfter || ''} seconds and try again.`);
      } else {
        setError(data.error || 'Authentication failed');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, password })
      });

      const data = await response.json();
      
      if (response.ok) {
        onLogin(sessionId);
      } else {
        setError(data.error || 'Invalid password');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-form-container">
      <div className="login-form card">
        <h2>Login to Telegram</h2>
        <p className="subtitle">Access your channels and download videos</p>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {step === 'choice' && (
          <div className="login-choice">
            <button 
              className="btn btn-primary full-width"
              onClick={handleQRLogin}
              disabled={loading}
            >
              {loading ? <span className="loading"></span> : '📱 Login with QR Code (Recommended)'}
            </button>
            <div className="divider">OR</div>
            <button 
              className="btn btn-secondary full-width"
              onClick={handlePhoneLogin}
            >
              📞 Login with Phone Number
            </button>
            <p className="help-text" style={{ marginTop: '20px', fontSize: '14px', color: '#666' }}>
              <strong>QR Code Login:</strong> Open Telegram on your phone, go to Settings → Devices → Link Desktop Device, and scan the QR code.
            </p>
          </div>
        )}

        {step === 'qr' && (
          <div className="qr-login">
            {qrCode && (
              <>
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                  <img src={qrCode} alt="QR Code" style={{ maxWidth: '300px', border: '1px solid #ddd', borderRadius: '8px', padding: '10px' }} />
                </div>
                <p style={{ textAlign: 'center', fontSize: '16px', marginBottom: '10px' }}>
                  <strong>Scan this QR code with Telegram</strong>
                </p>
                <ol style={{ fontSize: '14px', color: '#666', maxWidth: '400px', margin: '0 auto' }}>
                  <li>Open Telegram on your phone</li>
                  <li>Go to <strong>Settings → Devices</strong></li>
                  <li>Tap <strong>Link Desktop Device</strong></li>
                  <li>Point your phone at this screen to scan the code</li>
                </ol>
                {checkingQR && (
                  <p style={{ textAlign: 'center', marginTop: '20px', color: '#007bff' }}>
                    <span className="loading"></span> Waiting for QR code scan...
                  </p>
                )}
                <button 
                  type="button" 
                  className="btn btn-secondary full-width mt-10"
                  onClick={() => {
                    setStep('choice');
                    setQrCode('');
                    setCheckingQR(false);
                    setError('');
                  }}
                  style={{ marginTop: '20px' }}
                >
                  Back to Login Options
                </button>
              </>
            )}
          </div>
        )}

        {step === 'phone' && (
          <form onSubmit={handlePhoneSubmit}>
            <div className="form-group">
              <label>Phone Number</label>
              <input
                type="tel"
                className="input"
                placeholder="+1234567890"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                disabled={loading}
              />
              <small>Enter your phone number with country code</small>
            </div>
            <button 
              type="submit" 
              className="btn btn-primary full-width"
              disabled={loading || !phone}
            >
              {loading ? <span className="loading"></span> : 'Send Code'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleCodeSubmit}>
            <div className="form-group">
              <label>Verification Code</label>
              <input
                type="text"
                className="input"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                disabled={loading}
                maxLength="6"
              />
              <small>Enter the verification code sent to {phone}</small>
            </div>
            <button 
              type="submit" 
              className="btn btn-primary full-width"
              disabled={loading || !code}
            >
              {loading ? <span className="loading"></span> : 'Verify'}
            </button>
            <button 
              type="button" 
              className="btn btn-secondary full-width mt-10"
              onClick={() => {
                setStep('phone');
                setCode('');
                setError('');
              }}
            >
              Change Number
            </button>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={handlePasswordSubmit}>
            <div className="form-group">
              <label>Two-Factor Password</label>
              <input
                type="password"
                className="input"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />
              <small>Your account has two-factor authentication enabled</small>
            </div>
            <button 
              type="submit" 
              className="btn btn-primary full-width"
              disabled={loading || !password}
            >
              {loading ? <span className="loading"></span> : 'Login'}
            </button>
            <button 
              type="button" 
              className="btn btn-secondary full-width mt-10"
              onClick={() => {
                setStep('choice');
                setPhone('');
                setError('');
              }}
            >
              Back to Login Options
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default LoginForm;