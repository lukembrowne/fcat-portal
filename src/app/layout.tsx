import type { Metadata } from "next";
import { cookies } from "next/headers";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { getCurrentUser } from "@/lib/auth";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { SidebarNav } from "@/components/sidebar-nav";
import { FloatingJobProgress } from "@/components/floating-job-progress";
import { Toaster } from "@/components/ui/sonner";
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
              <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 min-w-0">
                <div className="mx-auto max-w-screen-2xl">{children}</div>
              </main>
            </SidebarInset>
            <FloatingJobProgress />
          </SidebarProvider>
        ) : (
          <main className="container mx-auto px-4 py-6">{children}</main>
        )}
        <Toaster position="bottom-left" />
        <Script
          defer
          src="https://analytics.fcat-ecuador.org/script.js"
          data-website-id="897a93d9-04b4-4657-83d6-0923833d1811"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
