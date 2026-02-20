<?php
/**
 * Template Name: Front Page
 * Description: Homepage template for Elite Cuts Barbershop
 */

get_header();
?>

<!-- Hero Section -->
<section class="hero" id="home">
    <div class="container">
        <h1>Precision Cuts, Premium Style</h1>
        <p>Experience the art of barbering with our skilled professionals. Book your appointment online and get the perfect look you deserve.</p>
        <button class="btn btn-primary" id="bookNowBtn">Book Appointment</button>
    </div>
</section>

<!-- Barbers Section -->
<section id="barbers">
    <div class="container">
        <div class="section-title">
            <h2>Meet Our Barbers</h2>
            <p>Our talented team of barbers are experts in their craft, ready to give you the perfect cut.</p>
        </div>
        <div class="barbers-grid">
            <?php
            $barbers = new WP_Query(array(
                'post_type' => 'barber',
                'posts_per_page' => -1,
            ));
            
            if ($barbers->have_posts()) :
                while ($barbers->have_posts()) : $barbers->the_post();
                    $experience = get_post_meta(get_the_ID(), '_barber_experience', true);
                    $specialties = get_post_meta(get_the_ID(), '_barber_specialties', true);
                    $specialties_array = !empty($specialties) ? array_map('trim', explode(',', $specialties)) : array();
            ?>
                <div class="barber-card">
                    <?php if (has_post_thumbnail()) : ?>
                        <?php the_post_thumbnail('medium', array('class' => 'barber-img')); ?>
                    <?php else : ?>
                        <img src="https://images.unsplash.com/photo-1562157873-818bc0726f68?w=400" alt="<?php the_title(); ?>" class="barber-img">
                    <?php endif; ?>
                    <div class="barber-info">
                        <h3><?php the_title(); ?></h3>
                        <p><?php echo esc_html($experience ? $experience : 'Professional Barber'); ?></p>
                        <?php if (!empty($specialties_array)) : ?>
                            <div class="specialties">
                                <?php foreach ($specialties_array as $specialty) : ?>
                                    <span class="specialty"><?php echo esc_html($specialty); ?></span>
                                <?php endforeach; ?>
                            </div>
                        <?php endif; ?>
                        <button class="btn btn-primary book-barber" data-barber="<?php the_title(); ?>">Book <?php echo esc_html(explode(' ', get_the_title())[0]); ?></button>
                    </div>
                </div>
            <?php
                endwhile;
                wp_reset_postdata();
            else :
                // Default barbers if none are added
                $default_barbers = array(
                    array('name' => 'Marcus Johnson', 'exp' => 'Master Barber with 10+ years experience', 'specialties' => array('Fades', 'Beard Trims', 'Classic Cuts'), 'img' => 'https://images.unsplash.com/photo-1562157873-818bc0726f68?w=400'),
                    array('name' => 'Carlos Rodriguez', 'exp' => 'Specialist in modern styles and trends', 'specialties' => array('Designs', 'Pompadours', 'Skin Fades'), 'img' => 'https://images.unsplash.com/photo-1580618672591-eb180b1a973f?w=400'),
                    array('name' => 'James Wilson', 'exp' => 'Expert in traditional and vintage styles', 'specialties' => array('Traditional Cuts', 'Hot Towel Shaves', 'Mustache Grooming'), 'img' => 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400'),
                );
                
                foreach ($default_barbers as $barber) :
            ?>
                <div class="barber-card">
                    <img src="<?php echo esc_url($barber['img']); ?>" alt="<?php echo esc_attr($barber['name']); ?>" class="barber-img">
                    <div class="barber-info">
                        <h3><?php echo esc_html($barber['name']); ?></h3>
                        <p><?php echo esc_html($barber['exp']); ?></p>
                        <div class="specialties">
                            <?php foreach ($barber['specialties'] as $specialty) : ?>
                                <span class="specialty"><?php echo esc_html($specialty); ?></span>
                            <?php endforeach; ?>
                        </div>
                        <button class="btn btn-primary book-barber" data-barber="<?php echo esc_attr($barber['name']); ?>">Book <?php echo esc_html(explode(' ', $barber['name'])[0]); ?></button>
                    </div>
                </div>
            <?php
                endforeach;
            endif;
            ?>
        </div>
    </div>
</section>

<!-- Services Section -->
<section id="services">
    <div class="container">
        <div class="section-title">
            <h2>Our Services</h2>
            <p>We offer a wide range of services to keep you looking sharp and feeling confident.</p>
        </div>
        <div class="services-grid">
            <?php
            $services = new WP_Query(array(
                'post_type' => 'service',
                'posts_per_page' => -1,
            ));
            
            if ($services->have_posts()) :
                while ($services->have_posts()) : $services->the_post();
                    $price = get_post_meta(get_the_ID(), '_service_price', true);
                    $icon = get_post_meta(get_the_ID(), '_service_icon', true);
                    if (empty($icon)) $icon = 'fas fa-cut';
            ?>
                <div class="service-card">
                    <div class="service-icon">
                        <i class="<?php echo esc_attr($icon); ?>"></i>
                    </div>
                    <h3><?php the_title(); ?></h3>
                    <p><?php echo wp_trim_words(get_the_content(), 15); ?></p>
                    <div class="price">$<?php echo esc_html($price ? $price : '0'); ?></div>
                </div>
            <?php
                endwhile;
                wp_reset_postdata();
            else :
                // Default services if none are added
                $default_services = array(
                    array('name' => 'Classic Haircut', 'desc' => 'Traditional haircut with precision and attention to detail', 'price' => '35', 'icon' => 'fas fa-cut'),
                    array('name' => 'Beard Trim & Shape', 'desc' => 'Professional beard trimming and shaping for a polished look', 'price' => '20', 'icon' => 'fas fa-user-tie'),
                    array('name' => 'Hot Towel Shave', 'desc' => 'Relaxing hot towel shave with premium products', 'price' => '40', 'icon' => 'fas fa-spa'),
                    array('name' => 'Royal Treatment', 'desc' => 'Full service including haircut, shave, and facial massage', 'price' => '75', 'icon' => 'fas fa-crown'),
                );
                
                foreach ($default_services as $service) :
            ?>
                <div class="service-card">
                    <div class="service-icon">
                        <i class="<?php echo esc_attr($service['icon']); ?>"></i>
                    </div>
                    <h3><?php echo esc_html($service['name']); ?></h3>
                    <p><?php echo esc_html($service['desc']); ?></p>
                    <div class="price">$<?php echo esc_html($service['price']); ?></div>
                </div>
            <?php
                endforeach;
            endif;
            ?>
        </div>
    </div>
</section>

<!-- Appointment Section -->
<section class="appointment-section" id="appointment">
    <div class="container">
        <div class="section-title">
            <h2 style="color: white;">Book Your Appointment</h2>
            <p style="color: #ddd;">Schedule your visit with our expert barbers</p>
        </div>
        <div class="appointment-container">
            <div>
                <h3 style="color: white; margin-bottom: 1.5rem;">Why Choose Us?</h3>
                <ul style="color: #ddd; list-style: none;">
                    <li style="margin-bottom: 1rem; display: flex; align-items: flex-start;">
                        <i class="fas fa-check" style="color: var(--accent); margin-right: 0.8rem; margin-top: 0.3rem;"></i>
                        <span>Expert barbers with years of experience</span>
                    </li>
                    <li style="margin-bottom: 1rem; display: flex; align-items: flex-start;">
                        <i class="fas fa-check" style="color: var(--accent); margin-right: 0.8rem; margin-top: 0.3rem;"></i>
                        <span>Premium grooming products</span>
                    </li>
                    <li style="margin-bottom: 1rem; display: flex; align-items: flex-start;">
                        <i class="fas fa-check" style="color: var(--accent); margin-right: 0.8rem; margin-top: 0.3rem;"></i>
                        <span>Comfortable and hygienic environment</span>
                    </li>
                    <li style="margin-bottom: 1rem; display: flex; align-items: flex-start;">
                        <i class="fas fa-check" style="color: var(--accent); margin-right: 0.8rem; margin-top: 0.3rem;"></i>
                        <span>Flexible scheduling with online booking</span>
                    </li>
                </ul>
            </div>
            <div class="appointment-form">
                <h3 style="margin-bottom: 1.5rem; color: var(--primary);">Schedule Now</h3>
                <form id="appointmentForm">
                    <div class="form-group">
                        <label for="barberSelect">Select Barber</label>
                        <select id="barberSelect" class="form-control" required>
                            <option value="">Choose a barber</option>
                            <?php
                            $barbers = get_posts(array('post_type' => 'barber', 'posts_per_page' => -1));
                            foreach ($barbers as $barber) {
                                echo '<option value="' . esc_attr($barber->post_title) . '">' . esc_html($barber->post_title) . '</option>';
                            }
                            ?>
                            <option value="Any Barber">Any Available Barber</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="serviceSelect">Select Service</label>
                        <select id="serviceSelect" class="form-control" required>
                            <option value="">Choose a service</option>
                            <?php
                            $services = get_posts(array('post_type' => 'service', 'posts_per_page' => -1));
                            foreach ($services as $service) {
                                $price = get_post_meta($service->ID, '_service_price', true);
                                echo '<option value="' . esc_attr($service->post_title) . '">' . esc_html($service->post_title) . ' - $' . esc_html($price) . '</option>';
                            }
                            ?>
                        </select>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label for="appointmentDate">Date</label>
                            <input type="date" id="appointmentDate" class="form-control" required>
                        </div>
                        <div class="form-group">
                            <label for="appointmentTime">Time</label>
                            <input type="time" id="appointmentTime" class="form-control" required>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="customerName">Your Name</label>
                        <input type="text" id="customerName" class="form-control" required>
                    </div>
                    <div class="form-group">
                        <label for="customerPhone">Phone Number</label>
                        <input type="tel" id="customerPhone" class="form-control" required>
                    </div>
                    <button type="submit" class="btn btn-primary" style="width: 100%;">Book Appointment</button>
                    <div id="appointmentMessage" style="margin-top: 1rem; display: none;"></div>
                </form>
            </div>
        </div>
    </div>
</section>

<!-- Loyalty Program -->
<section id="loyalty">
    <div class="container">
        <div class="section-title">
            <h2>Loyalty Rewards Program</h2>
            <p>Earn points with every visit and redeem them for exclusive rewards</p>
        </div>
        <div class="loyalty-program">
            <div class="loyalty-card">
                <h3>Your EliteCuts Rewards</h3>
                <p>Earn 10 points for every dollar spent</p>
                <?php if (is_user_logged_in()) : ?>
                    <?php
                    $user_id = get_current_user_id();
                    $points = get_user_meta($user_id, 'loyalty_points', true);
                    $points = $points ? $points : 0;
                    ?>
                    <div class="points-display"><?php echo esc_html(number_format($points)); ?></div>
                <?php else : ?>
                    <div class="points-display">0</div>
                <?php endif; ?>
                <p>Points Available</p>
                
                <div class="benefits-list">
                    <h4 style="margin: 1.5rem 0 1rem;">Redeem Your Points</h4>
                    <ul>
                        <li><i class="fas fa-gift"></i> 500 points - Free beard trim</li>
                        <li><i class="fas fa-gift"></i> 1,000 points - 25% off any service</li>
                        <li><i class="fas fa-gift"></i> 1,500 points - Free haircut</li>
                        <li><i class="fas fa-gift"></i> 2,500 points - Royal treatment package</li>
                    </ul>
                </div>
                
                <?php if (is_user_logged_in()) : ?>
                    <button class="btn btn-primary" style="margin-top: 1.5rem;">Redeem Points</button>
                <?php else : ?>
                    <a href="<?php echo wp_login_url(); ?>" class="btn btn-primary" style="margin-top: 1.5rem; text-decoration: none;">Login to View Points</a>
                <?php endif; ?>
            </div>
        </div>
    </div>
</section>

<?php get_footer(); ?>
