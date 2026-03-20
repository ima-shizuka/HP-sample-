import { useState } from 'react';
import { Lock } from 'lucide-react';
import { getAdminPin } from '../lib/db';

export default function AdminLogin({ onLogin }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (pin === getAdminPin()) {
      onLogin();
    } else {
      setError('PINが間違っています');
      setPin('');
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8">
      <div className="flex items-center gap-3">
        <div className="bg-blue-100 rounded-full p-3">
          <Lock className="w-7 h-7 text-blue-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">管理者ログイン</h1>
      </div>
      <form onSubmit={handleSubmit} className="w-full max-w-xs space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">管理者PIN</label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            className="input-field text-center text-2xl tracking-widest"
            placeholder="••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            maxLength={8}
            autoFocus
          />
          {error && <p className="text-red-500 text-xs text-center">{error}</p>}
        </div>
        <button type="submit" className="btn-primary">ログイン</button>
      </form>
      <p className="text-gray-400 text-xs">
        デフォルトPINは環境変数 VITE_ADMIN_PIN で設定できます
      </p>
    </div>
  );
}
