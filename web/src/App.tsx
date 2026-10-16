import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getToken } from './api';
import LoginPage from './pages/LoginPage';
import Workspace from './pages/Workspace';

function RequireAuth({ children }: { children: ReactElement }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <Workspace />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
