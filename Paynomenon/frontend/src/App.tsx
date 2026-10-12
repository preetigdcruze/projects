import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Incidents, IncidentDetailPage } from './pages/Incidents';
import { Investigations } from './pages/Investigations';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { PaymentDetail } from './pages/PaymentDetail';
import { Payments } from './pages/Payments';
import { Reconciliation } from './pages/Reconciliation';
import { SystemHealth } from './pages/SystemHealth';

export function App() {
  const { session } = useAuth();
  if (!session) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="payments" element={<Payments />} />
        <Route path="payments/:id" element={<PaymentDetail />} />
        <Route path="reconciliation" element={<Reconciliation />} />
        <Route path="investigations" element={<Investigations />} />
        <Route path="incidents" element={<Incidents />} />
        <Route path="incidents/:id" element={<IncidentDetailPage />} />
        <Route path="system" element={<SystemHealth />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
