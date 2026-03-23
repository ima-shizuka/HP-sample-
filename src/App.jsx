import { useState, useEffect } from 'react';
import RegistrationForm from './components/RegistrationForm';
import AdminPanel from './components/AdminPanel';
import AdminLogin from './components/AdminLogin';
import UpgradeResponse from './components/UpgradeResponse';
import { subscribeToSessions } from './lib/db';
import './index.css';

function Header() {
  return (
    <div className="bg-blue-600 text-white px-4 py-4 sticky top-0 z-10 shadow-md">
      <div className="flex items-center gap-3">
        <span className="text-2xl">🏓</span>
        <div>
          <h1 className="text-lg font-bold leading-tight">細江卓研 休日強化練習予約フォーム</h1>
          <p className="text-blue-200 text-xs">練習参加の出欠登録</p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);

  // Parse URL params
  const params = new URLSearchParams(window.location.search);
  const upgradeToken = params.get('upgrade');
  const isAdmin = params.get('admin') === '1';

  useEffect(() => {
    document.title = isAdmin
      ? '細江卓研 休日練習 【管理者画面】'
      : '細江卓研 休日練習予約';
  }, [isAdmin]);

  useEffect(() => {
    const unsub = subscribeToSessions((data) => {
      setSessions(data);
      setSessionsLoading(false);
    });
    return () => unsub();
  }, []);

  // ── Upgrade response page
  if (upgradeToken) {
    return <UpgradeResponse token={upgradeToken} />;
  }

  // ── Admin area
  if (isAdmin) {
    if (!adminLoggedIn) {
      return <AdminLogin onLogin={() => setAdminLoggedIn(true)} />;
    }
    return (
      <AdminPanel
        onLogout={() => {
          setAdminLoggedIn(false);
          window.location.href = '/';
        }}
      />
    );
  }

  // ── Main parent-facing app
  return (
    <div className="min-h-screen">
      <Header />
      <div className="pb-8">
        {sessionsLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-400">
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm">読み込み中...</p>
          </div>
        ) : (
          <RegistrationForm sessions={sessions} />
        )}
      </div>
      {/* Hidden admin link */}
      <div className="fixed bottom-4 right-4">
        <a href="?admin=1" className="text-gray-300 text-xs opacity-30 hover:opacity-60">
          管理
        </a>
      </div>
    </div>
  );
}
