import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { SidebarNav } from "@/components/sidebar-nav";
import { TopHeader } from "@/components/top-header";
import { FloatingJobProgress } from "@/components/floating-job-progress";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Portal FCAT",
  description: "Plataforma interna de FCAT para personal y colaboradores",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();
  const cookieStore = await cookies();
  const sidebarState = cookieStore.get("sidebar_state")?.value;
  const defaultOpen = sidebarState !== "false";

  return (
    <html lang="es">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {user ? (
          <SidebarProvider defaultOpen={defaultOpen}>
            <SidebarNav user={user} />
            <SidebarInset className="min-w-0">
              <TopHeader />
              <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 min-w-0">
                <div className="mx-auto max-w-7xl">{children}</div>
              </main>
            </SidebarInset>
            <FloatingJobProgress />
          </SidebarProvider>
        ) : (
          <main className="container mx-auto px-4 py-6">{children}</main>
        )}
      </body>
    </html>
  );
}
