import { Webhooks } from "@polar-sh/nextjs";
import { supabaseAdmin } from '@/lib/supabase/admin';

export const POST = Webhooks({
    webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,

    onCheckoutCreated: async (payload) => {
        console.log('Checkout created:', payload.data.id);
    },

    onOrderCreated: async (payload) => {
        const order = payload.data as Record<string, unknown>;
        console.log('Order created:', order.id);

        // 주문 기록 저장
        try {
            await supabaseAdmin.from('payment_orders').insert({
                polar_order_id: order.id as string,
                customer_email: (order.customer as Record<string, unknown>)?.email as string || null,
                amount: (order as Record<string, unknown>).amount as number || 0,
                currency: (order as Record<string, unknown>).currency as string || 'usd',
                status: 'completed',
                metadata: order.metadata,
            });
        } catch (error) {
            console.error('Failed to save order:', error);
        }

        // pending_analysis 상태 업데이트
        const metadata = order.metadata as Record<string, string> | undefined;
        const pendingAnalysisId = metadata?.pending_analysis_id;

        if (pendingAnalysisId) {
            await supabaseAdmin
                .from('pending_analysis')
                .update({
                    status: 'paid',
                    polar_checkout_id: order.checkoutId as string,
                })
                .eq('id', pendingAnalysisId);
        }
    },

    onOrderPaid: async (payload) => {
        console.log('Order paid:', payload.data.id);
    },

    onOrderRefunded: async (payload) => {
        const order = payload.data as Record<string, unknown>;
        console.log('Order refunded:', order.id);

        const metadata = order.metadata as Record<string, string> | undefined;
        const pendingAnalysisId = metadata?.pending_analysis_id;

        if (pendingAnalysisId) {
            await supabaseAdmin
                .from('pending_analysis')
                .update({ status: 'refunded' })
                .eq('id', pendingAnalysisId);
        }
    },
});
