import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { AdminLayout } from "./views/AdminLayout";
import { AppDetailPage } from "./views/AppDetailPage";
import { DashboardPage } from "./views/DashboardPage";
import { AppsPage } from "./views/AppsPage";
import { FeedbackPage } from "./views/FeedbackPage";
import { JobDetailPage } from "./views/JobDetailPage";
import { KbsPage } from "./views/KbsPage";
import { KbDetailPage } from "./views/KbDetailPage";
import { JobsPage } from "./views/JobsPage";
import { LoginPage } from "./views/LoginPage";
import { ObservabilityPage } from "./views/ObservabilityPage";
import { PageDetailPage } from "./views/PageDetailPage";
import { PagesPage } from "./views/PagesPage";
import { QualityPage } from "./views/QualityPage";
import { RetrievalEventDetailPage } from "./views/RetrievalEventDetailPage";
import { SettingsPage } from "./views/SettingsPage";
import { requireToken } from "./lib/auth";

function RequireAdminLayout() {
  const location = useLocation();
  if (!requireToken()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <AdminLayout />;
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RequireAdminLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="apps" element={<AppsPage />} />
          <Route path="apps/:appId" element={<AppDetailPage />} />
          <Route path="kbs" element={<KbsPage />} />
          <Route path="kbs/:kbId" element={<KbDetailPage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="jobs/:jobId" element={<JobDetailPage />} />
          <Route path="pages" element={<PagesPage />} />
          <Route path="pages/:pageId" element={<PageDetailPage />} />
          <Route path="feedback" element={<FeedbackPage />} />
          <Route path="quality" element={<QualityPage />} />
          <Route path="observability" element={<ObservabilityPage />} />
          <Route path="observability/retrieval-events/:eventId" element={<RetrievalEventDetailPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
